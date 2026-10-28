//! Deadline 定时器 —— 移植 Stretchly app/utils/scheduler.js
//!
//! 关键差异（对应 correct() 语义）：
//! - deadline 用 SystemTime（挂钟），sleep 只是"等剩余量"；
//! - 系统睡眠唤醒后由外部发 PlannerCommand::Correct 重挂（RunEvent::Resumed 触发）；
//! - 挂钟被改导致 remaining<=0 时按 0 处理（立即触发，等价 JS 中 timeLeft 为负）。

use std::time::{Duration, SystemTime};

/// 对齐 scheduler.js 的 reference 字符串
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    StartMicrobreakNotification,
    StartMicrobreak,
    FinishMicrobreak,
    StartBreakNotification,
    StartBreak,
    FinishBreak,
    ResumeBreaks,
}

impl Phase {
    /// 正在进行的休息（守卫用：不被 idle/DND 打断，见 breaksPlanner.js L34）
    pub fn is_finish_phase(&self) -> bool {
        matches!(self, Phase::FinishMicrobreak | Phase::FinishBreak)
    }
}

#[derive(Debug, Clone)]
pub struct Deadline {
    pub phase: Phase,
    pub at: SystemTime,
    /// 挂表时的总时长（progressPercentage 分母用）
    pub total: Duration,
}

impl Deadline {
    pub fn after(phase: Phase, duration: Duration) -> Self {
        Self { phase, at: SystemTime::now() + duration, total: duration }
    }

    pub fn remaining(&self) -> Duration {
        SystemTime::now()
            .duration_since(self.at)
            .err()
            .map(|e| e.duration())
            .unwrap_or(Duration::ZERO)
    }

    /// 已过去的挂钟比例（托盘进度条 0~100）
    pub fn progress_percent(&self) -> u32 {
        let elapsed = self.total.saturating_sub(self.remaining());
        ((elapsed.as_millis() as f64 / self.total.as_millis().max(1) as f64) * 100.0) as u32
    }
}
