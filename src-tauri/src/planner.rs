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
#[allow(dead_code)] // NextBreak/Shutdown 为 IPC 与优雅退出预留
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
    /// 状态快照（get_status IPC 读）：等待期无广播，设置页打开时靠它立即渲染
    snapshot: Arc<Mutex<serde_json::Value>>,
    /// 上一次 tooltip 文本（每秒 tick 时变化才真正 set，省系统调用）
    last_tooltip: String,
}

impl Planner {
    fn s(&self) -> Settings {
        self.store.lock().unwrap().settings.clone()
    }

    fn emit(&self, kind: &str, data: serde_json::Value) {
        // 跨线程 emit 偶发投递失败（前端有 1s get_status 轮询兜底），错误记录便于观察
        if let Err(e) = self.app.emit("planner", json!({ "type": kind, "data": data })) {
            eprintln!("perchly: planner emit failed: {e}");
        }
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
            // 小写枚举名对齐前端 kindMap（format!("{k:?}") 会产出 "Micro"/"Long"，
            // 前端查表 miss 后直接把英文裸串显示出来）
            "nextBreakKind": self.scheduled_kind().map(|k| match k {
                BreakKind::Micro => "micro",
                BreakKind::Long => "long",
            }),
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
        if let Err(e) = self.app.emit("status", self.status()) {
            eprintln!("perchly: planner status emit failed: {e}");
        }
        self.refresh_shared();
    }

    /// 刷新共享快照 + 托盘 tooltip。announce 与每秒 tick 都走这里；
    /// 不广播事件——前端有本地插值，无需高频推送。
    fn refresh_shared(&mut self) {
        *self.snapshot.lock().unwrap() = self.status();
        let text = self.tooltip_text();
        if text != self.last_tooltip {
            self.last_tooltip = text.clone();
            tray::set_tooltip(&self.app, &text);
        }
    }

    fn tooltip_text(&self) -> String {
        if self.paused {
            return "已暂停".into();
        }
        let fmt = |ms: u64| format!("{}:{:02}", ms / 60000, (ms % 60000) / 1000);
        let Some(d) = self.deadline.as_ref() else {
            return "未在计时".into();
        };
        let s = self.s();
        let rem = d.remaining().as_millis() as u64;
        match d.phase {
            // 休息进行中：显示本次休息剩余
            Phase::FinishMicrobreak => format!("微休息中 {}", fmt(rem)),
            Phase::FinishBreak => format!("长休息中 {}", fmt(rem)),
            // 开了通知的等待期：到通知触发还要 rem，通知本身再占 notif_int
            Phase::StartMicrobreakNotification => {
                format!("下一次微休息 {}", fmt(rem + s.microbreak_notification_interval))
            }
            Phase::StartBreakNotification => {
                format!("下一次长休息 {}", fmt(rem + s.break_notification_interval))
            }
            // 通知进行中（到点即休息）/ 未开通知的整段等待：remaining 即答案
            Phase::StartMicrobreak | Phase::StartBreak => format!("下一次休息 {}", fmt(rem)),
            Phase::ResumeBreaks => "已暂停".into(),
        }
    }

    // ============ 触发处理（对应 EventEmitter 回调） ============

    fn on_deadline(&mut self) {
        let phase = self.deadline.as_ref().unwrap().phase;
        match phase {
            // 注意：先挂好新 deadline 再 announce——广播出去的 status 必须是新阶段，
            // 否则前端拿到的是刚结束的旧阶段（remaining=0/progress=100%），插值全推不动
            Phase::StartMicrobreakNotification => {
                let s = self.s();
                self.deadline = Some(Deadline::after(
                    Phase::StartMicrobreak,
                    Duration::from_millis(s.microbreak_notification_interval),
                ));
                self.announce("microbreak-notification");
            }
            Phase::StartBreakNotification => {
                let s = self.s();
                self.deadline = Some(Deadline::after(
                    Phase::StartBreak,
                    Duration::from_millis(s.break_notification_interval),
                ));
                self.announce("break-notification");
            }
            Phase::StartMicrobreak => {
                let s = self.s();
                overlay::show(&self.app, BreakKind::Micro, &s);
                self.deadline = Some(Deadline::after(
                    Phase::FinishMicrobreak,
                    Duration::from_millis(s.microbreak_duration),
                ));
                self.announce("microbreak-started");
            }
            Phase::StartBreak => {
                let s = self.s();
                overlay::show(&self.app, BreakKind::Long, &s);
                self.deadline = Some(Deadline::after(
                    Phase::FinishBreak,
                    Duration::from_millis(s.break_duration),
                ));
                self.announce("break-started");
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
                self.next_break();
                self.announce("resumed");
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

    /// 清空计时。若正在休息（遮罩显示中），先关遮罩——Reset/Pause 等显式命令
    /// 踩掉 Finish deadline 时必须连带收掉遮罩，否则全屏卡住直到下个休息顶替。
    /// （IdleCleared/NaturalBreakFinished 有守卫，不会带 Finish 相位走到这里。）
    fn clear(&mut self) {
        if self
            .deadline
            .as_ref()
            .map(|d| d.phase.is_finish_phase())
            .unwrap_or(false)
        {
            overlay::hide(&self.app);
        }
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
        // 先重排再 announce：resumed 附带的 status 应是新周期，而不是空的 none
        self.next_break();
        self.announce("resumed");
        self.announce("status");
    }

    /// 守卫：进行中的休息不被外部事件打断（L34）。
    /// deadline=None（未在计时——长空闲 IdleCleared 之后、或两类休息都关着）没有
    /// 保护对象，必须放行：否则长空闲回来的 NaturalBreakFinished 被守卫拦下，
    /// next_break 不执行，永远停在「未在计时」（游标冻结）。
    fn interrupt_guard_ok(&self) -> bool {
        !self.paused
            && self
                .deadline
                .as_ref()
                .map(|d| !d.phase.is_finish_phase())
                .unwrap_or(true)
    }

    // ============ 主循环 ============

    pub fn run(
        app: AppHandle,
        store: Arc<Mutex<SettingsStore>>,
        snapshot: Arc<Mutex<serde_json::Value>>,
        rx: std::sync::mpsc::Receiver<Cmd>,
    ) {
        let mut p = Self {
            app,
            store,
            deadline: None,
            break_number: 0,
            postpones: 0,
            paused: false,
            snapshot,
            last_tooltip: String::new(),
        };
        p.next_break();
        p.announce("status");
        loop {
            // 等待上限 1s：即使整个等待期无命令、无广播，也每秒 tick 一次，
            // 刷新托盘 tooltip 与 get_status 快照（等待期可达数十分钟，不 tick 就冻结在旧值）
            let wait = match &p.deadline {
                Some(d) => d.remaining(),
                None => Duration::from_secs(1),
            }
            .min(Duration::from_secs(1));
            match rx.recv_timeout(wait) {
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
                    // 守卫：休息进行中不改排——next_break 会踩掉 Finish deadline，
                    // 遮罩永远等不到关闭（表现为全屏休息卡住）。新设置在休息结束后的
                    // next_break 里自然生效（届时读的是最新配置）。
                    if !p.paused && p.interrupt_guard_ok() {
                        p.next_break();
                        p.announce("status");
                    }
                }
                Ok(Cmd::Shutdown) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    let due = p.deadline.as_ref().map(|d| d.remaining().is_zero()).unwrap_or(false);
                    if due {
                        p.on_deadline();
                    } else {
                        // 每秒 tick：只刷 tooltip/快照，不广播（前端本地插值）
                        p.refresh_shared();
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
