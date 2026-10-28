//! Perchly 入口：装配设置、planner 线程、空闲监视线程、托盘、IPC

mod idle;
mod overlay;
mod planner;
mod scheduler;
mod settings;
mod tray;

use planner::{Cmd, Planner};
use settings::SettingsStore;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use tauri::Manager;

struct AppCtx {
    tx: mpsc::Sender<Cmd>,
    store: Arc<Mutex<SettingsStore>>,
    current_break: Arc<Mutex<Option<BreakInfo>>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakInfo {
    pub kind: settings::BreakKind,
    pub duration_ms: u64,
    #[serde(serialize_with = "epoch_ms")]
    pub started_at: std::time::SystemTime,
}

/// SystemTime → Unix epoch 毫秒（前端直接做减法算倒计时）
fn epoch_ms<S: serde::Serializer>(t: &std::time::SystemTime, s: S) -> Result<S::Ok, S::Error> {
    use std::time::UNIX_EPOCH;
    let ms = t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    s.serialize_u64(ms)
}

impl serde::Serialize for settings::BreakKind {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(match self {
            settings::BreakKind::Micro => "micro",
            settings::BreakKind::Long => "long",
        })
    }
}

#[tauri::command]
fn get_current_break(ctx: tauri::State<AppCtx>) -> Option<BreakInfo> {
    ctx.current_break.lock().unwrap().clone()
}

#[tauri::command]
fn get_settings(ctx: tauri::State<AppCtx>) -> serde_json::Value {
    let guard = ctx.store.lock().unwrap();
    serde_json::to_value(&guard.settings).unwrap()
}

#[tauri::command]
fn update_settings(patch: serde_json::Value, ctx: tauri::State<AppCtx>) -> Result<(), String> {
    {
        let mut guard = ctx.store.lock().unwrap();
        guard.update(patch)?;
    }
    let _ = ctx.tx.send(Cmd::SettingsChanged);
    Ok(())
}

#[tauri::command]
fn skip_current(ctx: tauri::State<AppCtx>) {
    let _ = ctx.tx.send(Cmd::SkipCurrent);
}

#[tauri::command]
fn postpone_break(ctx: tauri::State<AppCtx>) {
    let _ = ctx.tx.send(Cmd::Postpone);
}

#[tauri::command]
fn save_pet_position(x: i32, y: i32, ctx: tauri::State<AppCtx>) -> Result<(), String> {
    let mut guard = ctx.store.lock().unwrap();
    guard.update(serde_json::json!({ "petPosX": x, "petPosY": y }))
}

pub fn run() {
    tauri::Builder::default()
        // 单实例保护：必须最先注册（第二个实例启动时直接退出，并唤起已有实例）
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            // 已有实例收到信号：弹出设置窗口作为可见反馈（settings 是按需创建的）
            match app.get_webview_window("settings") {
                Some(w) => {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                None => {
                    let _ = tauri::WebviewWindowBuilder::new(
                        app,
                        "settings",
                        tauri::WebviewUrl::App("/".into()),
                    )
                    .title("Perchly 设置")
                    .inner_size(720.0, 540.0)
                    .resizable(true)
                    .build()
                    .map_err(|e| eprintln!("perchly: settings window build failed: {e}"))
                    .and_then(|w| w.set_focus().map_err(|e| eprintln!("perchly: focus failed: {e}")));
                }
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            update_settings,
            get_current_break,
            skip_current,
            postpone_break,
            save_pet_position,
            crate::idle::set_pet_drag,
            crate::idle::pet_drag_state,
            crate::idle::left_button_down
        ])
        .on_window_event(|window, event| {
            // 设置窗口：点 X 直接销毁（按需重建，不常驻 → 省 WebView 进程）
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "settings" {
                    // 已销毁，无需额外处理；下次托盘打开时按需重建
                }
            }
        })
        .setup(|app| {
            let store = Arc::new(Mutex::new(SettingsStore::load(app.handle())));
            let (tx, rx) = mpsc::channel::<Cmd>();
            let current_break: Arc<Mutex<Option<BreakInfo>>> = Arc::new(Mutex::new(None));

            // 先 manage 再启动 planner 线程（overlay::show 需要读到 AppCtx，消除竞态）
            app.manage(AppCtx { tx: tx.clone(), store: store.clone(), current_break: current_break.clone() });

            // planner 状态机线程（唯一权威）
            let planner_store = store.clone();
            let planner_app = app.handle().clone();
            std::thread::spawn(move || Planner::run(planner_app, planner_store, rx));

            // 空闲监视线程（自然休息）
            let s = store.lock().unwrap().settings.clone();
            if s.natural_breaks {
                let idle_tx = tx.clone();
                std::thread::spawn(move || {
                    idle::watch(
                        s.natural_breaks_check_interval,
                        s.natural_breaks_inactivity_reset_time,
                        idle_tx,
                    )
                });
            }

            tray::build(app.handle(), tx.clone());

            // 桌宠：恢复上次位置
            if let Some(w) = app.get_webview_window("pet") {
                if let (Some(x), Some(y)) = (s.pet_pos_x, s.pet_pos_y) {
                    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                }
                if !s.pet_enabled {
                    let _ = w.hide();
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 系统睡眠唤醒 → 等价 scheduler.js 的 correct()，按挂钟剩余时间重挂
            if matches!(event, tauri::RunEvent::Resumed) {
                if let Some(ctx) = app.try_state::<AppCtx>() {
                    let _ = ctx.tx.send(Cmd::Correct);
                }
            }
        });
}
