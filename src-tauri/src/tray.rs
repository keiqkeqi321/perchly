//! 托盘 —— 状态 tooltip + 常用操作菜单

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};

use crate::planner::Cmd;

pub fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id("perchly") {
        let _ = tray.set_tooltip(Some(text));
    }
}

pub fn build(app: &AppHandle, tx: std::sync::mpsc::Sender<Cmd>) {
    let skip_micro = MenuItem::with_id(app, "skip_to_micro", "跳到微休息", true, None::<&str>).unwrap();
    let skip_long = MenuItem::with_id(app, "skip_to_break", "跳到长休息", true, None::<&str>).unwrap();
    let postpone = MenuItem::with_id(app, "postpone", "推迟当前休息", true, None::<&str>).unwrap();
    let reset = MenuItem::with_id(app, "reset", "重置周期", true, None::<&str>).unwrap();
    let pause_1h = MenuItem::with_id(app, "pause_1h", "暂停 1 小时", true, None::<&str>).unwrap();
    let pause_forever = MenuItem::with_id(app, "pause_forever", "暂停（无限期）", true, None::<&str>).unwrap();
    let resume = MenuItem::with_id(app, "resume", "恢复", true, None::<&str>).unwrap();
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>).unwrap();
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>).unwrap();

    let menu = Menu::with_items(
        app,
        &[&skip_micro, &skip_long, &postpone, &reset, &pause_1h, &pause_forever, &resume, &settings, &quit],
    )
    .unwrap();

    let _ = TrayIconBuilder::with_id("perchly")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref().to_string();
            match id.as_str() {
                "skip_to_micro" => { let _ = tx.send(Cmd::SkipToMicrobreak); }
                "skip_to_break" => { let _ = tx.send(Cmd::SkipToBreak); }
                "postpone" => { let _ = tx.send(Cmd::Postpone); }
                "reset" => { let _ = tx.send(Cmd::Reset); }
                "pause_1h" => { let _ = tx.send(Cmd::Pause(Some(3_600_000))); }
                "pause_forever" => { let _ = tx.send(Cmd::Pause(None)); }
                "resume" => { let _ = tx.send(Cmd::Resume); }
                "settings" => {
                    // 按需创建：平时不占 WebView 进程（内存策略）
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
                            .skip_taskbar(false)
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
        })
        .build(app);
}
