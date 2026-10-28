//! 全屏休息遮罩 —— 移植 main.js 的逐显示器窗口逻辑
//! show(): 每个显示器一个 break-<n> 窗口（win32 全屏 + 置顶）
//! hide(): 逐窗销毁（内存策略：遮罩不常驻）

use crate::settings::{BreakKind, Settings};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub fn show(app: &AppHandle, kind: BreakKind, s: &Settings) {
    hide(app); // 防重入
    let monitors = match app.available_monitors() {
        Ok(m) => m,
        Err(_) => return,
    };
    let kind_q = match kind { BreakKind::Micro => "micro", BreakKind::Long => "long" };
    let _ = kind_q;
    let duration_ms = match kind {
        BreakKind::Micro => s.microbreak_duration,
        BreakKind::Long => s.break_duration,
    };
    // 当前休息信息存入全局状态，break.html 加载时通过 get_current_break 拉取
    if let Some(ctx) = app.try_state::<crate::AppCtx>() {
        *ctx.current_break.lock().unwrap() = Some(crate::BreakInfo {
            kind,
            duration_ms,
            started_at: std::time::SystemTime::now(),
        });
    }
    let visible_list: Vec<_> = monitors.into_iter().collect();
    let primary_only = !s.all_screens;
    // tauri Monitor 无 PartialEq：用位置坐标识别主屏
    let primary_pos = app.primary_monitor().ok().flatten().map(|p| *p.position());
    for (i, m) in visible_list.iter().enumerate() {
        if primary_only && Some(m.position()) != primary_pos.as_ref() {
            continue;
        }
        let pos = m.position();
        let size = m.size();
        let label = if primary_only { "break-0".into() } else { format!("break-{i}") };
        let url = format!("/break.html");
        let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .position(pos.x as f64, pos.y as f64)
            .inner_size(size.width as f64, size.height as f64)
            .fullscreen(true)
            .always_on_top(true)
            .decorations(false)
            .skip_taskbar(true)
            .resizable(false)
            .shadow(false)
            .build();
        if let Err(e) = win {
            eprintln!("perchly: overlay build failed: {e}");
        }
    }
}

pub fn hide(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if label.starts_with("break-") {
            let _ = win.close();
        }
    }
}
