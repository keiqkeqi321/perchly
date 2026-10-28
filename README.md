# Perchly

> 休息提醒 + 桌面宠物 —— 低内存的 Stretchly 替代品（Tauri 2 + Rust）

一只玄凤鹦鹉住在你的桌面上：你工作太久它会犯困、打哈欠，休息时间到了它跳起来提醒你；休息中它开心跳舞。核心是完整移植 [Stretchly](https://github.com/hovancik/stretchly) 的休息调度状态机（微休息/长休息交错、前置通知、推迟、跳过、自然休息、睡眠唤醒纠偏），但用 Rust 重写、以约 1/3 的内存常驻运行。

## 特性

- ⏰ **完整休息调度**：微休息 + 长休息交错、前置通知、推迟（限次/限时窗口）、严格模式、自然休息（空闲检测，Win `GetLastInputInfo` / macOS `CGEventSource`）、系统睡眠唤醒后挂钟纠偏
- 🦜 **桌宠**：纯 SVG 玄凤鹦鹉，8 种状态（呼吸/眨眼/歪头/犯困打哈欠/提醒跳跃/跳舞/跺脚/派对帽彩蛋），窗口穿透 + 点击交互 + 拖拽记忆位置 + 双击回托盘
- 🖥 **多显示器**：休息时每个屏幕一个全屏遮罩，倒计时圆环 + 随机休息建议
- 📉 **低资源**：Rust 核心常驻 ~27MB；安装包 3.87MB（Stretchly 约 90MB）；无高频轮询；设置窗口按需创建
- 🇨🇳 中文界面、托盘菜单、设置页

## 快速开始

```bash
npm install
npm run tauri dev        # 开发
./scripts/build.sh       # 一键打包（NSIS 安装包；Windows 可直接双击 scripts\build.cmd）
```

> 打包若遇 NSIS 工具链下载超时（GitHub 直连慢），走镜像：
> `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR=https://ghfast.top npm run tauri build`

Windows 10/11 开箱即用（WebView2 系统自带）；macOS 构建需真机（见 docs/ARCHITECTURE.md 平台差异备忘）。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构与决策记录（窗口分层、模块地图、硬指标）
- [docs/STRETCHLY_NOTES.md](docs/STRETCHLY_NOTES.md) —— Stretchly 源码学习笔记与移植对照（行为对齐依据）
- [docs/DEVLOG.md](docs/DEVLOG.md) —— 开发日志、验证记录、踩坑清单

## 项目结构

```
src-tauri/src/
  lib.rs        装配入口：状态、IPC 命令、托盘、事件
  planner.rs    休息状态机（移植 breaksPlanner.js）
  scheduler.rs  挂钟 Deadline 定时器（移植 scheduler.js）
  idle.rs       空闲检测 + 自然休息三段式
  overlay.rs    逐显示器全屏遮罩
  settings.rs   配置（默认值对齐 Stretchly v1.22.1）
  tray.rs       托盘菜单
src/            前端三页面（Vite 多入口，无框架）
  pet.ts + pet/ 桌宠（状态机、穿透、拖拽）
  main.ts       设置页
  break.ts      休息遮罩
```

## License

MIT
