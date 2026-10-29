//! 托盘 —— 状态 tooltip + 常用操作菜单 + 桌宠皮肤切换
//!
//! 菜单可整体重建（build_menu + rebuild_menu）：皮肤切换后重挂菜单刷新勾选态。
//! 同一份菜单也用于桌宠右键（popup）：菜单事件挂全局 on_menu_event，两个入口共用。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::planner::Cmd;
use crate::settings::PetSkin;

pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id("perchly") {
        let _ = tray.set_tooltip(Some(text));
    }
}

/// 构建完整菜单（皮肤勾选态按当前设置渲染）
fn build_menu(app: &AppHandle, _tx: &std::sync::mpsc::Sender<Cmd>) -> Menu<tauri::Wry> {
    let s = crate::settings::current(app);
    let skin = s.pet_skin;

    let skip_micro = MenuItem::with_id(app, "skip_to_micro", "跳到微休息", true, None::<&str>).unwrap();
    let skip_long = MenuItem::with_id(app, "skip_to_break", "跳到长休息", true, None::<&str>).unwrap();
    let postpone = MenuItem::with_id(app, "postpone", "推迟当前休息", true, None::<&str>).unwrap();
    let reset = MenuItem::with_id(app, "reset", "重置周期", true, None::<&str>).unwrap();
    let pause_1h = MenuItem::with_id(app, "pause_1h", "暂停 1 小时", true, None::<&str>).unwrap();
    let pause_forever = MenuItem::with_id(app, "pause_forever", "暂停（无限期）", true, None::<&str>).unwrap();
    let resume = MenuItem::with_id(app, "resume", "恢复", true, None::<&str>).unwrap();

    // —— 桌宠显隐（文案随 petEnabled 翻转：设置是唯一事实源，
    //    显隐变化都走 apply_pet_enabled 即时同步窗口与设置，两者不脱钩）——
    let show_pet = MenuItem::with_id(
        app, "show_pet",
        if s.pet_enabled { "隐藏桌宠" } else { "显示桌宠" },
        true, None::<&str>,
    ).unwrap();

    // —— 桌宠皮肤子菜单（勾选单选）——
    let sk_svg = CheckMenuItem::with_id(
        app, "skin_svg", "SVG 鹦鹉",
        true, skin == PetSkin::Svg, None::<&str>,
    ).unwrap();
    let sk_pack = CheckMenuItem::with_id(
        app, "skin_pack", "宠物包动画（默认）",
        !s.pack_missing, skin == PetSkin::Pack, None::<&str>,
    ).unwrap();
    let skin_menu = Submenu::with_id_and_items(
        app, "pet_skin", "桌宠皮肤", true,
        &[&sk_svg, &sk_pack],
    ).unwrap();

    // —— 开机自启（勾选态=系统注册项实际状态，非 settings.json；用户可能在
    //    任务管理器/系统设置里改过，每次构建菜单时现读）——
    let autostart = CheckMenuItem::with_id(
        app, "autostart", "开机自启动",
        true, crate::autostart_enabled(app), None::<&str>,
    ).unwrap();

    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>).unwrap();
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>).unwrap();

    Menu::with_items(
        app,
        &[
            &skip_micro, &skip_long, &postpone, &reset,
            &PredefinedMenuItem::separator(app).unwrap(),
            &pause_1h, &pause_forever, &resume,
            &PredefinedMenuItem::separator(app).unwrap(),
            &show_pet,
            &skin_menu,
            &autostart,
            &PredefinedMenuItem::separator(app).unwrap(),
            &settings, &quit,
        ],
    )
    .unwrap()
}

/// 首次构建（setup 里调用；须在桌宠初始显隐落定之后，菜单文案才准确）
pub fn build(app: &AppHandle, tx: std::sync::mpsc::Sender<Cmd>) {
    let menu = build_menu(app, &tx);
    let _ = TrayIconBuilder::with_id("perchly")
        .icon(tauri::include_image!("icons/32x32.png"))
        .tooltip("Perchly")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .build(app);

    // 菜单事件挂全局：托盘菜单与桌宠右键 popup 菜单共用一份 handle_menu。
    // 只挂这一处——若同时挂 tray 专属 on_menu_event 会双重触发
    app.on_menu_event(move |app, event| {
        let id = event.id().as_ref().to_string();
        handle_menu(app, &tx, id.as_str());
    });
}

/// 桌宠右键：在光标处弹出与托盘一致的菜单（每次新鲜构建，勾选态/显隐文案即时）
pub fn popup(app: &AppHandle) {
    let Some(w) = app.get_webview_window("pet") else { return };
    let Some(ctx) = app.try_state::<crate::AppCtx>() else { return };
    let menu = build_menu(app, &ctx.tx);
    // Windows 原生菜单要求所属窗口前台，否则点击菜单外区域不消失
    let _ = w.set_focus();
    if let Err(e) = w.popup_menu(&menu) {
        eprintln!("perchly: 桌宠右键菜单弹出失败: {e}");
    }
}

/// 皮肤切换后重建菜单刷新勾选态
pub fn rebuild(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("perchly") {
        if let Some(tx) = app.try_state::<crate::AppCtx>().map(|c| c.tx.clone()) {
            let _ = tray.set_menu(Some(build_menu(app, &tx)));
        }
    }
}

fn handle_menu(app: &AppHandle, tx: &std::sync::mpsc::Sender<Cmd>, id: &str) {
    use tauri::Emitter;
    match id {
        "skip_to_micro" => { let _ = tx.send(Cmd::SkipToMicrobreak); }
        "skip_to_break" => { let _ = tx.send(Cmd::SkipToBreak); }
        "postpone" => { let _ = tx.send(Cmd::Postpone); }
        "reset" => { let _ = tx.send(Cmd::Reset); }
        "pause_1h" => { let _ = tx.send(Cmd::Pause(Some(3_600_000))); }
        "pause_forever" => { let _ = tx.send(Cmd::Pause(None)); }
        "resume" => { let _ = tx.send(Cmd::Resume); }
        "show_pet" => {
            // 显隐切换：与设置页开关同一逻辑（petEnabled 唯一事实源：
            // 持久化 + 立即生效 + 广播事件同步设置页 UI，重启后状态一致。
            // 此前只切窗口不落盘——重启桌宠复活，且设置页开关只落盘不生效）
            let next = !crate::settings::current(app).pet_enabled;
            if let Some(ctx) = app.try_state::<crate::AppCtx>() {
                let _ = ctx.store.lock().unwrap().update(
                    serde_json::json!({ "petEnabled": next })
                );
            }
            crate::apply_pet_enabled(app, next);
        }
        "skin_svg" | "skin_pack" => {
            // 写设置 + 通知桌宠窗口热切换 + 重建菜单刷新勾选
            let skin = if id == "skin_svg" { PetSkin::Svg } else { PetSkin::Pack };
            // 重复点同一皮肤跳过：避免 pack→pack 重入（中间会短暂回显 SVG 闪一帧）
            if crate::settings::current(app).pet_skin == skin {
                return;
            }
            if let Some(ctx) = app.try_state::<crate::AppCtx>() {
                let _ = ctx.store.lock().unwrap().update(
                    serde_json::json!({ "petSkin": skin.as_str() })
                );
            }
            let _ = app.emit("pet-skin-changed", skin.as_str());
            rebuild(app);
        }
        "autostart" => {
            // 与设置页开关同一逻辑：以系统注册项当前状态为基准翻转（外部改动也能
            // 正确切回），写回后广播同步设置页 UI + 重建菜单刷新勾选
            let next = !crate::autostart_enabled(app);
            match crate::apply_autostart(app, next) {
                Ok(actual) => {
                    let _ = app.emit("launch-on-startup-changed", actual);
                    rebuild(app);
                }
                Err(e) => eprintln!("perchly: 开机自启动切换失败: {e}"),
            }
        }
        "settings" => {
            match app.get_webview_window("settings") {
                Some(w) => {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                None => {
                    let built = tauri::WebviewWindowBuilder::new(
                        app,
                        "settings",
                        tauri::WebviewUrl::App("/".into()),
                    )
                    .title("Perchly 设置")
                    .inner_size(720.0, 540.0)
                    .resizable(true)
                    .build();
                    if let Err(e) = built {
                        eprintln!("perchly: settings window build failed: {e}");
                    }
                }
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}
