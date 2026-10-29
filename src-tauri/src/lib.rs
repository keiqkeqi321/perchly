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
    /// planner 状态快照（planner 线程每秒 tick / 每次切换时更新；get_status 读）
    planner_status: Arc<Mutex<serde_json::Value>>,
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

/// planner 当前状态快照：设置页打开时立即渲染状态条（等待期无广播，等第一个事件要几分钟）
#[tauri::command]
fn get_status(ctx: tauri::State<AppCtx>) -> serde_json::Value {
    ctx.planner_status.lock().unwrap().clone()
}

#[tauri::command]
fn update_settings(
    app: tauri::AppHandle,
    patch: serde_json::Value,
    ctx: tauri::State<AppCtx>,
) -> Result<(), String> {
    // petSkin 前后值（锁各自短作用域：rebuild 内部会再锁 store，std Mutex 不可重入）
    let skin_before = ctx.store.lock().unwrap().settings.pet_skin;
    {
        let mut guard = ctx.store.lock().unwrap();
        guard.update(patch)?;
    }
    let skin_after = ctx.store.lock().unwrap().settings.pet_skin;

    // petSkin 实际变化 → 通知桌宠热切换 + 刷新托盘勾选。
    // 此前设置页路径不发事件，皮肤要重启才变；且设置页先改后托盘点同名项会被
    // 「已是该皮肤」提前 return，也不发事件——两条路都表现为"切不动"
    if skin_before != skin_after {
        use tauri::Emitter;
        let _ = app.emit("pet-skin-changed", skin_after.as_str());
        crate::tray::rebuild(&app);
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

/// 桌宠右键：在光标处弹出与托盘一致的菜单
#[tauri::command]
fn popup_pet_menu(app: tauri::AppHandle) {
    crate::tray::popup(&app);
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
            get_status,
            update_settings,
            get_current_break,
            skip_current,
            postpone_break,
            save_pet_position,
            popup_pet_menu,
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
            let planner_status: Arc<Mutex<serde_json::Value>> =
                Arc::new(Mutex::new(serde_json::Value::Null));

            // 先 manage 再启动 planner 线程（overlay::show 需要读到 AppCtx，消除竞态）
            app.manage(AppCtx {
                tx: tx.clone(),
                store: store.clone(),
                current_break: current_break.clone(),
                planner_status: planner_status.clone(),
            });

            // planner 状态机线程（唯一权威）
            let planner_store = store.clone();
            let planner_app = app.handle().clone();
            std::thread::spawn(move || {
                Planner::run(planner_app, planner_store, planner_status, rx)
            });

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

            // 桌宠：恢复上次位置（须在托盘构建前落定显隐，菜单「显示/隐藏桌宠」文案才准确）
            if let Some(w) = app.get_webview_window("pet") {
                if let (Some(x), Some(y)) = (s.pet_pos_x, s.pet_pos_y) {
                    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
                }
                if !s.pet_enabled {
                    let _ = w.hide();
                }
            }

            tray::build(app.handle(), tx.clone());

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
