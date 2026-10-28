# Perchly 架构与目标（决策记录）

> 一句话：用 Tauri 2 复刻 Stretchly 的休息提醒，内存压到其 1/3，并加一只会回应你的桌宠。

## 硬指标（不达标即返工）

- 常驻内存 ≤ 70MB（Windows WebView2 / macOS WKWebView）
- 空闲 CPU ≈ 0%（无高频轮询；idle 检测 10s 粒度；桌宠动画 30fps 上限）
- 双平台流畅：Win10/11 + macOS 12+

## 窗口分层（三窗口分治）

| 窗口 label | 生命周期 | 特性 |
|---|---|---|
| `settings` | 默认隐藏，打开时 show | 常规窗口，关闭即 hide（保状态） |
| `pet` | 常驻 | 透明、无边框、置顶、跳过任务栏、220x220；身体包围盒内可点击，外围穿透 |
| `break` | 到点按显示器数创建，结束即销毁 | 全屏遮罩（win32 kiosk/fullscreen），置顶 |

## Rust 模块地图（src-tauri/src/）

```
lib.rs        入口：状态装配、托盘、事件总线（tauri Emitter 广播到所有窗口）
scheduler.rs  Deadline 定时器（SystemTime + Phase enum）← 移植 scheduler.js
planner.rs    休息状态机（交错/通知/postpone/skip/pause/守卫）← 移植 breaksPlanner.js
idle.rs       空闲检测（Win: GetLastInputInfo / Mac: CGEventSource）+ 自然休息三段式
overlay.rs    逐显示器遮罩窗口的创建/关闭
settings.rs   JSON 配置 + 默认值 + 原子写（app_config_dir）
tray.rs       托盘菜单：状态/跳过/推迟/暂停/重置/设置/退出
pet.rs        桌宠窗口：穿透切换、拖拽、状态事件转发
```

事件流：planner 发 `break://event`（如 `microbreak-started`）→ 所有窗口监听；前端只做展示，**状态唯一权威在 Rust**。

## 前端（Vite 多入口）

- `index.html` 设置页（简单原生 TS，无框架 —— 省内存）
- `pet.html` 桌宠：canvas + 帧动画/Lottie；状态机 = planner 事件 + 随机小动作
- `break.html` 休息遮罩：倒计时圆环 + 提示文案 + 跳过/推迟按钮

## 桌宠状态机（M2）

```
idle(轻摆/眨眼) ←默认
  ├─ 工作越久 → sleepy(打哈欠) → 距休息<1min → remind(跳起来提醒)
  ├─ 休息中 → happy(跳舞/喝水)
  ├─ 点击 → 随机互动(歪头/说话/原地转圈)
  └─ 拖拽 → 拖影跟手，松手记住坐标(持久化)
```

## 平台差异备忘

- Win：manifest 声明 Per-Monitor DPI v2；`GetLastInputInfo` tick 回绕；WebView2 embedBootstrapper
- Mac：签名+公证；开机自启 `SMAppService`；kiosk 窗口勿与 CanJoinAllSpaces 混用；前台应用检测需屏幕录制权限（默认关）
- 睡眠唤醒：`RunEvent::Resumed` → deadline 重挂（见 STRETCHLY_NOTES §1）

## 里程碑

- **M1 核心**：scheduler/planner/idle 移植 + 托盘 + 遮罩 + 设置页（≈ Stretchly 平替）✅ 验收用 docs/STRETCHLY_NOTES.md §7 清单
- **M2 桌宠**：pet 窗口 + idle/remind/happy 三状�� + 点击互动 + 拖拽记忆
- **M3 完整**：postpone/skip UI、声音、开机自启、多屏完善、内存达标实测
- **M4 增强**：DND 联动、App 黑名单、音乐律动（WASAPI loopback）、成就

## 参考资产

- Stretchly 源码：`~/Projects/stretchly`（学习笔记见 docs/STRETCHLY_NOTES.md）
- 设计参考：网易云桌面玄虎皮鹦鹉（截图见对话，交互节奏参考）
