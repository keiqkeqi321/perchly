//! 托盘 —— 状态 tooltip + 常用操作菜单 + 桌宠皮肤切换
//!
//! 菜单可整体重建（build_menu + rebuild_menu）：皮肤切换后重挂菜单刷新勾选态。

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
fn build_menu(app: &AppHandle, tx: &std::sync::mpsc::Sender<Cmd>) -> Menu<tauri::Wry> {
    let s = crate::settings::current(app);
    let skin = s.pet_skin;

    let skip_micro = MenuItem::with_id(app, "skip_to_micro", "跳到微休息", true, None::<&str>).unwrap();
    let skip_long = MenuItem::with_id(app, "skip_to_break", "跳到长休息", true, None::<&str>).unwrap();
    let postpone = MenuItem::with_id(app, "postpone", "推迟当前休息", true, None::<&str>).unwrap();
    let reset = MenuItem::with_id(app, "reset", "重置周期", true, None::<&str>).unwrap();
    let pause_1h = MenuItem::with_id(app, "pause_1h", "暂停 1 小时", true, None::<&str>).unwrap();
    let pause_forever = MenuItem::with_id(app, "pause_forever", "暂停（无限期）", true, None::<&str>).unwrap();
    let resume = MenuItem::with_id(app, "resume", "恢复", true, None::<&str>).unwrap();

    // —— 桌宠皮肤子菜单（勾选单选）——
    let sk_svg = CheckMenuItem::with_id(
        app, "skin_svg", "SVG 鹦鹉（默认）",
        true, skin == PetSkin::Svg, None::<&str>,
    ).unwrap();
    let sk_netease = CheckMenuItem::with_id(
        app, "skin_netease", "网易云动作（直显）",
        !s.netease_missing, skin == PetSkin::Netease, None::<&str>,
    ).unwrap();
    let sk_netease_key = CheckMenuItem::with_id(
        app, "skin_netease_key", "网易云动作（透明抠像）",
        !s.netease_missing, skin == PetSkin::NeteaseKey, None::<&str>,
    ).unwrap();
    let skin_menu = Submenu::with_id_and_items(
        app, "pet_skin", "桌宠皮肤", true,
        &[&sk_svg, &sk_netease, &sk_netease_key],
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
            &skin_menu,
            &PredefinedMenuItem::separator(app).unwrap(),
            &settings, &quit,
        ],
    )
    .unwrap()
}

/// 首次构建（setup 里调用）
pub fn build(app: &AppHandle, tx: std::sync::mpsc::Sender<Cmd>) {
    let menu = build_menu(app, &tx);
    let _ = TrayIconBuilder::with_id("perchly")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref().to_string();
            handle_menu(app, &tx, id.as_str());
        })
        .build(app);
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
        "skin_svg" | "skin_netease" | "skin_netease_key" => {
            // 写设置 + 通知桌宠窗口热切换 + 重建菜单刷新勾选
            let skin = match id {
                "skin_svg" => PetSkin::Svg,
                "skin_netease" => PetSkin::Netease,
                _ => PetSkin::NeteaseKey,
            };
            if let Some(ctx) = app.try_state::<crate::AppCtx>() {
                let _ = ctx.store.lock().unwrap().update(
                    serde_json::json!({ "petSkin": skin.as_str() })
                );
            }
            let _ = app.emit("pet-skin-changed", skin.as_str());
            rebuild(app);
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
