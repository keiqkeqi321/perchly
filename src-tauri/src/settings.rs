//! 配置：默认值对齐 Stretchly defaultSettings.js（时间单位 ms）
//! 存储：app_config_dir/perchly.json，原子写（先写 tmp 再 rename）

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

/// 休息类型（planner/scheduler 共用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakKind {
    Micro,
    Long,
}

impl BreakKind {
    pub fn start_phase(&self) -> crate::scheduler::Phase {
        match self {
            BreakKind::Micro => crate::scheduler::Phase::StartMicrobreak,
            BreakKind::Long => crate::scheduler::Phase::StartBreak,
        }
    }
    pub fn notification_phase(&self) -> crate::scheduler::Phase {
        match self {
            BreakKind::Micro => crate::scheduler::Phase::StartMicrobreakNotification,
            BreakKind::Long => crate::scheduler::Phase::StartBreakNotification,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub microbreak: bool,
    pub microbreak_duration: u64,
    pub microbreak_interval: u64,
    pub microbreak_notification: bool,
    pub microbreak_notification_interval: u64,
    pub microbreak_postpone: bool,
    pub microbreak_postpone_time: u64,
    pub microbreak_postpones_limit: u32,
    pub microbreak_strict_mode: bool,
    pub break_: bool,
    pub break_duration: u64,
    pub break_interval: u32,
    pub break_notification: bool,
    pub break_notification_interval: u64,
    pub break_postpone: bool,
    pub break_postpone_time: u64,
    pub break_postpones_limit: u32,
    pub break_strict_mode: bool,
    pub natural_breaks: bool,
    pub natural_breaks_inactivity_reset_time: u64,
    pub natural_breaks_check_interval: u64,
    pub fullscreen: bool,
    pub all_screens: bool,
    pub pet_enabled: bool,
    pub pet_pos_x: Option<i32>,
    pub pet_pos_y: Option<i32>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            // —— 与 Stretchly v1.22.1 defaultSettings.js 逐项一致 ——
            microbreak: true,
            microbreak_duration: 20_000,
            microbreak_interval: 600_000,
            microbreak_notification: true,
            microbreak_notification_interval: 10_000,
            microbreak_postpone: true,
            microbreak_postpone_time: 120_000,
            microbreak_postpones_limit: 1,
            microbreak_strict_mode: false,
            break_: true,
            break_duration: 300_000,
            break_interval: 2,
            break_notification: true,
            break_notification_interval: 30_000,
            break_postpone: true,
            break_postpone_time: 300_000,
            break_postpones_limit: 1,
            break_strict_mode: false,
            natural_breaks: true,
            natural_breaks_inactivity_reset_time: 300_000,
            natural_breaks_check_interval: 2_000,
            fullscreen: false,
            all_screens: true,
            // —— Perchly 自有 ——
            pet_enabled: true,
            pet_pos_x: None,
            pet_pos_y: None,
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    pub settings: Settings,
}

impl SettingsStore {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let dir = app.path().app_config_dir().expect("no config dir");
        let path = dir.join("perchly.json");
        let settings = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { path, settings }
    }

    pub fn save(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(&self.settings).map_err(|e| e.to_string())?;
        fs::write(&tmp, json).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    pub fn update(&mut self, patch: serde_json::Value) -> Result<(), String> {
        if let serde_json::Value::Object(map) = patch {
            let mut cur = serde_json::to_value(&self.settings).map_err(|e| e.to_string())?;
            if let serde_json::Value::Object(cur_map) = &mut cur {
                for (k, v) in map {
                    cur_map.insert(k, v);
                }
            }
            self.settings = serde_json::from_value(cur).map_err(|e| e.to_string())?;
            self.save()
        } else {
            Err("patch must be an object".into())
        }
    }
}
