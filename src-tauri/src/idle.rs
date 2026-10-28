//! 空闲检测 + 自然休息三段式 —— 移植 naturalBreaksManager.js
//! Win: GetLastInputInfo / macOS: CGEventSourceSecondsSinceLastEventType
//! 三段：>20s 自然休息标记；>resetTime 清定时器；回来→周期重置

use crate::planner::Cmd;
use std::sync::mpsc::Sender;
use std::time::Duration;

#[cfg(target_os = "windows")]
pub fn idle_ms() -> u64 {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::System::SystemInformation::GetTickCount;
    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info).as_bool() {
            // tick 差值法：49.7 天回绕安全（无符号减法）
            let idle = GetTickCount().wrapping_sub(info.dwTime);
            idle as u64
        } else {
            0
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    // 直接声明 CoreGraphics C 接口，避免额外依赖 crate
    #[repr(C)]
    pub struct __CGEventSource;
    extern "C" {
        pub fn CGEventSourceCreate(state_id: i32) -> *mut __CGEventSource;
        pub fn CGEventSourceSecondsSinceLastEventType(
            source: *const __CGEventSource,
            event_type: u32,
        ) -> f64;
        pub fn CFRelease(cf: *const core::ffi::c_void);
    }
    pub const K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE: i32 = 0;
    pub const K_CG_ANY_INPUT_EVENT_TYPE: u32 = u32::MAX;
}

#[cfg(target_os = "macos")]
pub fn idle_ms() -> u64 {
    // CGEventSourceSecondsSinceLastEventType 查询无需辅助功能权限（EventTap 才需要）
    unsafe {
        let source = mac::CGEventSourceCreate(mac::K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE);
        if source.is_null() {
            return 0;
        }
        let s = mac::CGEventSourceSecondsSinceLastEventType(
            source,
            mac::K_CG_ANY_INPUT_EVENT_TYPE,
        );
        mac::CFRelease(source as *const core::ffi::c_void);
        (s * 1000.0) as u64
    }
}

/// 轮询循环（对齐 _checkIdleTime 的三段式）
pub fn watch(check_interval_ms: u64, reset_time_ms: u64, tx: Sender<Cmd>) {
    let mut is_on_natural_break = false;
    let mut last_idle: u64 = 0;
    loop {
        std::thread::sleep(Duration::from_millis(check_interval_ms));
        let idle = idle_ms();
        if !is_on_natural_break && idle > 20_000 {
            is_on_natural_break = true;
        }
        if is_on_natural_break && idle < 20_000 {
            is_on_natural_break = false;
            if last_idle > reset_time_ms {
                let _ = tx.send(Cmd::NaturalBreakFinished);
            }
        }
        if is_on_natural_break && idle > reset_time_ms {
            let _ = tx.send(Cmd::IdleCleared);
        }
        last_idle = idle;
        // 设置变更时由外部重建线程，v0.1 固定间隔
    }
}
