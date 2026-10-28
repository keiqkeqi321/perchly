//! 休息状态机 —— 移植 breaksPlanner.js（交错/通知/推迟/跳过/暂停/守卫）
//! 单活动 Deadline + 命令通道；状态唯一权威在此，前端只做展示。

use crate::scheduler::{Deadline, Phase};
use crate::settings::{BreakKind, Settings, SettingsStore};
use crate::{overlay, tray};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug)]
pub enum Cmd {
    /// 重新规划下一个周期（设置变更/启动）
    NextBreak,
    SkipToMicrobreak,
    SkipToBreak,
    /// 推迟当前（通知阶段或进行中的）休息
    Postpone,
    /// 立即结束当前休息（遮罩上的“跳过”按钮）
    SkipCurrent,
    /// None = 无限期
    Pause(Option<u64>),
    Resume,
    Reset,
    /// 系统睡眠唤醒（RunEvent::Resumed）→ 等价 scheduler.js correct()
    Correct,
    /// 空闲超过 inactivityResetTime → 放弃倒计时（breaksPlanner L33-38）
    IdleCleared,
    /// 长空闲后回到工作 → 周期重置（breaksPlanner L40-46）
    NaturalBreakFinished,
    SettingsChanged,
    Shutdown,
}

pub struct Planner {
    app: AppHandle,
    store: Arc<Mutex<SettingsStore>>,
    deadline: Option<Deadline>,
    /// 对齐 breaksPlanner.breakNumber：每周期 +1，%(breakInterval+1)==0 时长休息
    break_number: u32,
    postpones: u32,
    paused: bool,
}

impl Planner {
    fn s(&self) -> Settings {
        self.store.lock().unwrap().settings.clone()
    }

    fn emit(&self, kind: &str, data: serde_json::Value) {
        let _ = self.app.emit("planner", json!({ "type": kind, "data": data }));
    }

    fn status(&self) -> serde_json::Value {
        let (phase, remaining_ms, progress) = match &self.deadline {
            Some(d) => (
                format!("{:?}", d.phase),
                d.remaining().as_millis() as u64,
                d.progress_percent(),
            ),
            None => (String::from("none"), 0, 0),
        };
        json!({
            "phase": phase,
            "remainingMs": remaining_ms,
            "progressPercent": progress,
            "paused": self.paused,
            "breakNumber": self.break_number,
            "postpones": self.postpones,
            "nextBreakKind": self.scheduled_kind().map(|k| format!("{k:?}")),
        })
    }

    /// _scheduledBreakType（breaksPlanner L251-264）
    fn scheduled_kind(&self) -> Option<BreakKind> {
        let s = self.s();
        if s.break_ && s.microbreak {
            let bi = s.break_interval + 1;
            Some(if self.break_number % bi != 0 { BreakKind::Micro } else { BreakKind::Long })
        } else if !s.break_ {
            Some(BreakKind::Micro)
        } else if !s.microbreak {
            Some(BreakKind::Long)
        } else {
            None
        }
    }

    fn announce(&mut self, event: &str) {
        self.emit(event, json!({ "status": self.status() }));
        self.emit("status", self.status());
        if let Some(text) = self.tooltip_text() {
            tray::set_tooltip(&self.app, &text);
        }
    }

    fn tooltip_text(&self) -> Option<String> {
        let s = self.s();
        if self.paused {
            return Some("已暂停".into());
        }
        let d = self.deadline.as_ref()?;
        let ms = match d.phase {
            Phase::StartMicrobreakNotification | Phase::StartBreakNotification => {
                d.remaining().as_millis() as u64
                    + match d.phase {
                        Phase::StartMicrobreakNotification => s.microbreak_notification_interval,
                        _ => s.break_notification_interval,
                    }
            }
            _ => d.remaining().as_millis() as u64,
        };
        Some(format!("下一次休息 {}:{:02}", ms / 60000, (ms % 60000) / 1000))
    }

    // ============ 触发处理（对应 EventEmitter 回调） ============

    fn on_deadline(&mut self) {
        let phase = self.deadline.as_ref().unwrap().phase;
        match phase {
            Phase::StartMicrobreakNotification => {
                let s = self.s();
                self.announce("microbreak-notification");
                self.deadline = Some(Deadline::after(
                    Phase::StartMicrobreak,
                    Duration::from_millis(s.microbreak_notification_interval),
                ));
            }
            Phase::StartBreakNotification => {
                let s = self.s();
                self.announce("break-notification");
                self.deadline = Some(Deadline::after(
                    Phase::StartBreak,
                    Duration::from_millis(s.break_notification_interval),
                ));
            }
            Phase::StartMicrobreak => {
                let s = self.s();
                overlay::show(&self.app, BreakKind::Micro, &s);
                self.announce("microbreak-started");
                self.deadline = Some(Deadline::after(
                    Phase::FinishMicrobreak,
                    Duration::from_millis(s.microbreak_duration),
                ));
            }
            Phase::StartBreak => {
                let s = self.s();
                overlay::show(&self.app, BreakKind::Long, &s);
                self.announce("break-started");
                self.deadline = Some(Deadline::after(
                    Phase::FinishBreak,
                    Duration::from_millis(s.break_duration),
                ));
            }
            Phase::FinishMicrobreak | Phase::FinishBreak => {
                let kind = if matches!(phase, Phase::FinishMicrobreak) {
                    BreakKind::Micro
                } else {
                    BreakKind::Long
                };
                overlay::hide(&self.app);
                self.emit("planner", json!({ "type": format!("{kind:?}-finished").to_lowercase(), "data": { "skipped": false } }));
                self.next_break();
                self.announce("status");
            }
            Phase::ResumeBreaks => {
                self.paused = false;
                self.announce("resumed");
                self.next_break();
                self.announce("status");
            }
        }
    }

    // ============ nextBreak（breaksPlanner L113-153） ============

    fn next_break(&mut self) {
        let s = self.s();
        self.postpones = 0;
        if s.break_ && s.microbreak {
            self.break_number += 1;
            let bi = s.break_interval + 1;
            if self.break_number % bi == 0 {
                self.schedule_start(BreakKind::Long, s.microbreak_interval, &s);
            } else {
                self.schedule_start(BreakKind::Micro, s.microbreak_interval, &s);
            }
        } else if !s.break_ && s.microbreak {
            self.schedule_start(BreakKind::Micro, s.microbreak_interval, &s);
        } else if s.break_ && !s.microbreak {
            self.schedule_start(BreakKind::Long, s.microbreak_interval * (s.break_interval as u64 + 1), &s);
        } else {
            self.deadline = None;
        }
    }

    /// 通知开启 → 先挂到 interval - notificationInterval，触发后再挂剩余（L124-149）
    fn schedule_start(&mut self, kind: BreakKind, interval_ms: u64, s: &Settings) {
        let (notif_on, notif_int) = match kind {
            BreakKind::Micro => (s.microbreak_notification, s.microbreak_notification_interval),
            BreakKind::Long => (s.break_notification, s.break_notification_interval),
        };
        if notif_on {
            let delay = interval_ms.saturating_sub(notif_int).max(1);
            self.deadline = Some(Deadline::after(kind.notification_phase(), Duration::from_millis(delay)));
        } else {
            self.deadline = Some(Deadline::after(kind.start_phase(), Duration::from_millis(interval_ms)));
        }
    }

    // ============ 推迟（L164-180 + main.js canPostpone 守卫） ============

    fn postpone(&mut self) {
        let s = self.s();
        let Some(d) = &self.deadline else { return };
        let kind = match d.phase {
            Phase::FinishMicrobreak | Phase::StartMicrobreakNotification => BreakKind::Micro,
            Phase::FinishBreak | Phase::StartBreakNotification => BreakKind::Long,
            _ => return,
        };
        let (enabled, limit, postpone_ms) = match kind {
            BreakKind::Micro => (s.microbreak_postpone, s.microbreak_postpones_limit, s.microbreak_postpone_time),
            BreakKind::Long => (s.break_postpone, s.break_postpones_limit, s.break_postpone_time),
        };
        if !enabled || limit == 0 || self.postpones >= limit {
            return;
        }
        // 进行中的休息：前 30%（postponableDurationPercent）内可推迟（main.js L823-826）
        if matches!(d.phase, Phase::FinishMicrobreak | Phase::FinishBreak)
            && d.progress_percent() > 30
        {
            return;
        }
        self.postpones += 1;
        overlay::hide(&self.app);
        let notif = match kind {
            BreakKind::Micro => (s.microbreak_notification, s.microbreak_notification_interval),
            BreakKind::Long => (s.break_notification, s.break_notification_interval),
        };
        if notif.0 && postpone_ms > notif.1 {
            // 回到通知阶段（差值）
            self.deadline = Some(Deadline::after(
                kind.notification_phase(),
                Duration::from_millis(postpone_ms - notif.1),
            ));
        } else {
            self.deadline = Some(Deadline::after(kind.start_phase(), Duration::from_millis(postpone_ms)));
        }
        self.emit("planner", json!({ "type": format!("{kind:?}-finished").to_lowercase(), "data": { "postponed": true } }));
        self.announce("status");
    }

    // ============ 跳过（L182-208） ============

    fn skip_to_microbreak(&mut self) {
        let s = self.s();
        if s.break_ && s.microbreak {
            let bi = s.break_interval + 1;
            if self.break_number % bi == 0 {
                self.break_number = 1;
            }
        }
        self.deadline = Some(Deadline::after(Phase::StartMicrobreak, Duration::from_millis(100)));
        self.announce("status");
    }

    fn skip_to_break(&mut self) {
        let s = self.s();
        if s.break_ && s.microbreak {
            self.break_number = s.break_interval + 1;
        }
        self.deadline = Some(Deadline::after(Phase::StartBreak, Duration::from_millis(100)));
        self.announce("status");
    }

    /// 遮罩“跳过”按钮：结束当前休息并重排。canSkip 守卫（utils.js L57-59）
    fn skip_current(&mut self) {
        let Some(d) = &self.deadline else { return };
        if !d.phase.is_finish_phase() {
            return;
        }
        let s = self.s();
        let (postpone_enabled, strict) = match d.phase {
            Phase::FinishMicrobreak => (s.microbreak_postpone, s.microbreak_strict_mode),
            _ => (s.break_postpone, s.break_strict_mode),
        };
        let passed = d.progress_percent();
        if (postpone_enabled && passed <= 30) || strict {
            return;
        }
        let kind = if matches!(d.phase, Phase::FinishMicrobreak) { BreakKind::Micro } else { BreakKind::Long };
        overlay::hide(&self.app);
        self.emit("planner", json!({ "type": format!("{kind:?}-finished").to_lowercase(), "data": { "skipped": true } }));
        self.next_break();
        self.announce("status");
    }

    // ============ 暂停/恢复/清除（L210-249） ============

    fn clear(&mut self) {
        self.deadline = None;
        self.break_number = 0;
        self.postpones = 0;
    }

    fn pause(&mut self, ms: Option<u64>) {
        self.clear();
        self.paused = true;
        if let Some(ms) = ms {
            self.deadline = Some(Deadline::after(Phase::ResumeBreaks, Duration::from_millis(ms)));
        }
        self.announce("paused");
    }

    fn resume(&mut self) {
        self.deadline = None;
        self.paused = false;
        self.announce("resumed");
        self.next_break();
        self.announce("status");
    }

    /// 守卫：进行中的休息不被外部事件打断（L34）
    fn interrupt_guard_ok(&self) -> bool {
        !self.paused
            && self
                .deadline
                .as_ref()
                .map(|d| !d.phase.is_finish_phase())
                .unwrap_or(false)
    }

    // ============ 主循环 ============

    pub fn run(
        app: AppHandle,
        store: Arc<Mutex<SettingsStore>>,
        rx: std::sync::mpsc::Receiver<Cmd>,
    ) {
        let mut p = Self { app, store, deadline: None, break_number: 0, postpones: 0, paused: false };
        p.next_break();
        p.announce("status");
        loop {
            let wait = match &p.deadline {
                Some(d) => d.remaining(),
                None => Duration::from_secs(3600),
            };
            match rx.recv_timeout(wait.min(Duration::from_secs(3600))) {
                Ok(Cmd::NextBreak) => {
                    p.next_break();
                    p.announce("status");
                }
                Ok(Cmd::SkipToMicrobreak) => p.skip_to_microbreak(),
                Ok(Cmd::SkipToBreak) => p.skip_to_break(),
                Ok(Cmd::Postpone) => p.postpone(),
                Ok(Cmd::SkipCurrent) => p.skip_current(),
                Ok(Cmd::Pause(ms)) => p.pause(ms),
                Ok(Cmd::Resume) => p.resume(),
                Ok(Cmd::Reset) => {
                    p.clear();
                    p.next_break();
                    p.announce("status");
                }
                Ok(Cmd::Correct) => {
                    // 等价 scheduler.correct()：按剩余挂钟时间重挂
                    if let Some(d) = &p.deadline {
                        let (phase, rem) = (d.phase, d.remaining());
                        p.deadline = Some(Deadline::after(phase, rem));
                    }
                }
                Ok(Cmd::IdleCleared) => {
                    if p.interrupt_guard_ok() {
                        p.clear();
                    }
                }
                Ok(Cmd::NaturalBreakFinished) => {
                    if p.interrupt_guard_ok() {
                        p.clear();
                        p.next_break();
                        p.announce("status");
                    }
                }
                Ok(Cmd::SettingsChanged) => {
                    if !p.paused {
                        p.next_break();
                        p.announce("status");
                    }
                }
                Ok(Cmd::Shutdown) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let due = p.deadline.as_ref().map(|d| d.remaining().is_zero()).unwrap_or(false);
                    if due {
                        p.on_deadline();
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleave_math() {
        // breakInterval=2 → 每 3 个周期一次长休息（含首次）
        let bi = 2u32 + 1;
        let mut n = 0;
        let mut longs = vec![];
        for cycle in 1..=7 {
            n += 1;
            if n % bi == 0 {
                longs.push(cycle);
            }
        }
        assert_eq!(longs, vec![3, 6]);
    }
}
