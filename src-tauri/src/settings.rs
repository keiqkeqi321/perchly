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

/// 桌宠皮肤：svg=自绘鹦鹉状态机；pack=宠物包 WebM 直显
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PetSkin {
    Svg,
    Pack,
}

impl PetSkin {
    pub fn as_str(&self) -> &'static str {
        match self {
            PetSkin::Svg => "svg",
            PetSkin::Pack => "pack",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "svg" => Some(PetSkin::Svg),
            "pack" => Some(PetSkin::Pack),
            _ => None,
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
    /// 桌宠皮肤（json 存字符串；serde 序列化走 as_str/parse）
    pub pet_skin: PetSkin,
    /// 宠物包资源是否可用（运行时探测，不落盘；缺 manifest.json 则托盘禁用宠物包皮肤项）
    #[serde(skip)]
    pub pack_missing: bool,
    pub pet_pos_x: Option<i32>,
    pub pet_pos_y: Option<i32>,
    /// 「开机自启默认开启」的一次性标记：false=尚未初始化（下次启动自动开启一次）；
    /// true=已应用过或用户已显式切换过，此后不再自动改系统注册项。
    /// 注意自启动实际状态不落盘（注册表/launchd 为准），此字段只防
    /// 「用户关掉后又被默认值重新打开」。
    pub autostart_initialized: bool,
}

impl Serialize for PetSkin {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PetSkin {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(PetSkin::parse(&s).unwrap_or(PetSkin::Svg))
    }
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
            // 默认皮肤=宠物包动画（视频）；资源缺失时 pet.ts 会优雅回退 SVG
            pet_skin: PetSkin::Pack,
            pack_missing: false,
            pet_pos_x: None,
            pet_pos_y: None,
            autostart_initialized: false,
        }
    }
}

/// 快捷读取当前设置副本（托盘重建菜单等场景）
pub fn current(app: &tauri::AppHandle) -> Settings {
    app.try_state::<crate::AppCtx>()
        .map(|ctx| ctx.store.lock().unwrap().settings.clone())
        .unwrap_or_default()
}

pub struct SettingsStore {
    path: PathBuf,
    pub settings: Settings,
}

impl SettingsStore {
    pub fn load(app: &tauri::AppHandle) -> Self {
        let dir = app.path().app_config_dir().expect("no config dir");
        let path = dir.join("perchly.json");
        let mut settings: Settings = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // 宠物包资源可用性探测（运行时，不落盘）
        // dev：vite 从 public/ 提供资源，dist/ 未必构建过 → 探测项目 public/
        // release：dist 资源嵌进 exe（tauri 默认不落盘到安装目录），
        //          须查内嵌资产表（asset_resolver）而非文件系统——探 Resource 目录必然落空，
        //          曾导致安装版「宠物包动画」菜单项灰掉无法切换
        let manifest_exists = if cfg!(debug_assertions) {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../public/assets/pets/cockatiel/manifest.json")
                .exists()
        } else {
            app.asset_resolver()
                .get("assets/pets/cockatiel/manifest.json".into())
                .is_some()
        };
        settings.pack_missing = !manifest_exists;
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
            let pack_missing = self.settings.pack_missing; // serde(skip) 字段往返会丢，手动保留
            self.settings = serde_json::from_value(cur).map_err(|e| e.to_string())?;
            self.settings.pack_missing = pack_missing;
            self.save()
        } else {
            Err("patch must be an object".into())
        }
    }
}
