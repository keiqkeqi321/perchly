# AGENTS.md — Perchly 多 Agent 协作规范

> 面向在此仓库工作的 AI agent（及人类协作者）。目标：并行开发不冲突、决策可追溯、行为对齐有据可查。

## 项目一句话

Tauri 2 休息提醒 + 桌宠。Rust 侧移植 Stretchly 调度语义，前端三页面无框架。

## 必读文档（按顺序）

1. `docs/ARCHITECTURE.md` —— 架构决策、模块地图、窗口分层、硬指标（内存 ≤70MB 等）
2. `docs/STRETCHLY_NOTES.md` —— **行为对齐唯一依据**：所有调度行为（交错/通知/推迟/跳过/守卫/空闲三段式）以 Stretchly 源码对照为准，改 planner 前先读对应章节
3. `docs/DEVLOG.md` —— 踩坑记录（工具链/链接/穿透/打包），动手前扫一眼能省半天

## 文件所有权（并行开发的边界）

并行任务时，每个 agent 只写自己 scope 内的文件：

| 模块 | 文件 |
|---|---|
| Rust 核心 | `src-tauri/src/**`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/**` |
| 桌宠前端 | `pet.html`, `src/pet.ts`, `src/pet/**`, `src/styles/pet.css` |
| 设置页 | `index.html`, `src/main.ts`, `src/styles/settings.css` |
| 休息遮罩 | `break.html`, `src/break.ts`, `src/styles/break.css` |
| 文档 | `docs/**`, `README.md` |

跨边界改动（如加 IPC 命令）由根 agent 协调：先改 Rust 契约 → 通知前端 agent 适配。共享文件（package.json、tsconfig、vite.config）只有根 agent 可改。

## 关键契约（改动前必读）

### Rust ↔ 前端 IPC（lib.rs）
- `get_settings()` → 全量设置 JSON（camelCase，字段见 settings.rs）
- `update_settings(patch)` → 浅合并 + 原子落盘，成功后广播 `SettingsChanged`
- `get_current_break()` → `{ kind: "micro"|"long", durationMs, startedAt(epoch ms) } | null`
- `skip_current()` / `postpone_break()` / `save_pet_position(x, y)`

### 事件通道（tauri Emitter）
- 通道 `"planner"`：`{ type, data }`，type ∈ `microbreak-notification | break-notification | microbreak-started | break-started | micro-finished | long-finished | paused | resumed | status`
- 通道 `"status"`：裸状态对象 `{ phase, remainingMs, progressPercent, paused, breakNumber, postpones, nextBreakKind }`，**仅阶段切换时广播**——前端需本地插值显示倒计时

### 状态权威
**一切调度状态以 Rust planner 为唯一权威**。前端只做展示与转发，不自行计时决定行为（遮罩倒计时按 `startedAt + durationMs` 挂钟推算属展示层例外）。

## 编码约定

- Rust：中文注释；模块头 `//!` 说明对应 Stretchly 源码文件；不引入 tokio/async（当前 std 线程 + mpsc 足够）
- TS：strict；无框架无运行时依赖（仅 `@tauri-apps/api`）；CSS 独立文件；动画用 CSS keyframes，JS 侧禁止 rAF 常驻循环
- 时间单位：Rust 内部一律 ms（u64），字段名带 `_ms` 后缀或文档注明
- 配置键：serde camelCase，`break_` 序列化为 `break`

## 验证清单（提交前）

```bash
npx tsc --noEmit                      # TS 零错误
cd src-tauri && cargo test            # Rust 测试通过
cd src-tauri && CARGO_BUILD_JOBS=2 cargo build --release   # 见 DEVLOG 踩坑 #4
```

行为改动需对照 `docs/STRETCHLY_NOTES.md` §7 验收清单自测；涉及调度/遮罩的改动用短间隔配置（12s interval / 4s duration）E2E 验证后报告时间线证据。

## 环境备忘（本机已验证）

- 工具链：GNU（MSVC 缺 Windows SDK 不可用）；`CARGO_BUILD_JOBS=2` 防并行竞态
- 打包：NSIS 需 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR=https://ghfast.top` 镜像
- 快速杀干净测试实例：先 `Stop-Process perchly`，再杀命令行含 perchly 的 msedgewebview2，**等 3 秒**再启（WebView2 user-data-dir 锁）
