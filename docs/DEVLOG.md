# Perchly 开发日志

## 2026-10-27 v0.1.0 骨架完成（M1 全绿）

### 已完成
- **Rust 核心**（src-tauri/src/）
  - `scheduler.rs`：挂钟 Deadline 定时器（移植 scheduler.js，睡眠唤醒 Correct 语义）
  - `planner.rs`：完整休息状态机（交错/通知/postpone/skip/pause/守卫，332 行 breaksPlanner.js 对齐）
  - `idle.rs`：Win GetLastInputInfo / mac CGEventSource + 自然休息三段式
  - `overlay.rs`：逐显示器全屏遮罩（按需创建/销毁）
  - `tray.rs`：中文托盘菜单（设置窗口按需创建——省常驻 WebView）
  - `settings.rs`：默认值与 Stretchly v1.22.1 逐项一致；JSON 原子写
  - `lib.rs`：装配 + 6 个 IPC 命令 + RunEvent::Resumed → Correct
- **前端三页面**（Vite 多入口，无框架）
  - 设置页（分组卡片 + 状态条插值 + debounce 保存）
  - 休息遮罩（SVG 圆环倒计时 + 20 条文案 + 严格模式）
  - 桌宠（纯 SVG 玄凤鹦鹉 8 状态 + 穿透轮询 + 拖拽/双击/5连击彩蛋）
- **图标**：gpt-image-2 生成 teal 鹦鹉，PIL 裁多尺寸 + ico

### 验证记录
| 项 | 结果 |
|---|---|
| cargo test | ✅ 1 passed |
| tsc --noEmit | ✅ 0 errors |
| vite build | ✅ 3 入口全过 |
| release exe | ✅ 6.6MB |
| E2E：12s 间隔真实调度 | ✅ 双屏遮罩按期弹出/自动关闭/再调度（18:33:09 overlays=2 → :13 关 → :24 再弹）|
| release 内存 | Rust 核心 26.6MB ✅；WebView2 全家 ~307MB（其中 ~110MB 为 WebView2 共享进程固定开销）|
| 窗口枚举 | ✅ pet 220x220 置顶/透明/穿透（WS_EX_LAYERED+TRANSPARENT），settings 隐藏 |

### 踩坑记录（重要）
1. **GNU 工具链 cdylib**：`export ordinal too large` → desktop 不需要 cdylib，crate-type 去掉
2. **坏 dlltool**：`~/.local/bin/dlltool.exe` 是坏的（无输出版本），移出 PATH 后 GNU 链接修复
3. **MSVC 不可用**：VS2022 有编译器但缺 Windows SDK 库（8.1 是空壳）；装 SDK 后可切 MSVC
4. **Build 并行竞态**：`CARGO_BUILD_JOBS=2` 串行化后"metadata stub"消失
5. **WebView2 ERROR_BUSY (0x800700AA)**：实例被杀后 user-data-dir 未释放，紧接着重启会失败——等几秒再启
6. **pet 穿透**：Tauri v2 的 setIgnoreCursorEvents 无 Electron 式 forward 参数 → 前端 250ms cursorPosition 轮询方案（pet/pointer.ts）
7. **NSIS 工具链下载超时**：Tauri bundler 从 GitHub 直连下载 nsis-3.13.zip 会全局超时且清空缓存。解决：`TAURI_BUNDLER_TOOLS_GITHUB_MIRROR=https://ghfast.top npm run tauri build -- --bundles nsis`（镜像前缀拼在 GitHub URL 前）。打包结果：**3.87 MB** 安装包（对比 Stretchly ~90MB）
8. **crates.io 直连不通**（2026-10-28 起）：`static.crates.io` 超时。已配 `~/.cargo/config.toml` 换 rsproxy 镜像（`sparse+https://rsproxy.cn/index/`），编译恢复正常
9. **单实例验证坑**：tasklist/Get-CimInstance 会把"用户已安装的旧版"和"源码目录测试版"当成两个实例——判断前先看 CommandLine 路径。tauri-plugin-single-instance 锁的是 app identifier，**不同路径的 exe 互认互斥**（实测 D:\APP 安装版 vs 源码版）
10. **GitHub 镜像会轮换失效**（2026-10-28 实测）：ghfast.top TCP 可连但 HTTPS 传输 0 字节停滞，tauri bundler 下载 nsis-3.13.zip 卡死在 ESTABLISHED 连接上；curl 直测可复现（`curl --max-time 25` 探测，gh-proxy.com 当时可用且 ~180KB/s）。注意 bundler 内置下载器（ureq）走镜像很慢且**无任何进度输出**——"Downloading" 行停留 6 分钟≠卡死，`%LOCALAPPDATA%\tauri\NSIS\` 出现 makensis.exe 才算完成；缓存命中后重跑直接跳制包。`scripts/build.sh` 已改为 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR` 环境变量可覆盖、默认 gh-proxy.com。另：MSVC 工具链现已可用（SDK 已装），#3 的"GNU only"结论过期；`~/.cargo/config.toml`（rsproxy 镜像，见 #8）可能丢失需重建
11. **自然休息三连 bug**（2026-10-29 实测修复，planner.rs）：① 长空闲（>resetTime）IdleCleared 后 deadline=None，回来时 NaturalBreakFinished 被 `interrupt_guard_ok` 的 `unwrap_or(false)` 误拦 → 永远「未在计时」（游标冻结），改为 `unwrap_or(true)`（None 无保护对象须放行）；② SettingsChanged 处理器无守卫，休息中改设置 `next_break` 踩掉 Finish deadline → 全屏遮罩卡住直到下个休息顶替，补同一守卫；③ Reset/Pause 在休息中 clear() 同样踩 deadline 不关遮罩，clear() 里对 Finish 相位补 `overlay::hide`。验证法：临时把 interval/duration/resetTime 调小（35s/3s/25s），UIA 拨设置开关 + SendInput 注入输入，用 EnumWindows 观测遮罩窗口生灭
12. **planner 线程 app.emit 跨线程投递时灵时不灵**（2026-10-29 实测）：同一份代码，有的实例整会话收不到 status 事件（页面快照+插值倒数到 0:00 后永久冻结——用户重启后自启动场景复现），有的实例全程畅通；IPC 命令线程（async runtime）的 emit 与 invoke 从未失败。tao event proxy 层环境性抖动，非代码逻辑问题。**对策：设置页加 1s get_status 轮询兜底**（invoke 通道可靠），事件只当加速优化；emit 失败 eprintln 记录。诊断方法：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` 启动 exe + Node 内置 WebSocket 裸连 CDP，在页面里武装 `__TAURI__.event.listen` 探针再外部触发。另修 nextBreakKind 的 `format!("{k:?}")` 产出 "Micro" 裸串问题（前端 kindMap 只认小写，改 match 小写）

### 下一步（M2+）
- [ ] 真机观感调优：SVG 鹦鹉透明窗口合成、DPI>1 多屏坐标
- [ ] 桌宠事件联动实测（happy/remind 状态切换）
- [x] 开机自启（tauri-plugin-autostart 2.7：Win=注册表 Run 键 / macOS=LaunchAgent；默认开启仅首次执行一次，`autostartInitialized` 标记防「关掉又被打开」；实际状态以系统注册项为准不落盘，设置页开关与托盘勾选双向同步）
- [ ] 声音提醒、静音时段
- [ ] macOS 侧编译验证（需 mac 机器）
- [ ] 安装包（NSIS）+ 代码签名
- [ ] 内存进一步优化：尝试 WebView2 侧 timer throttling、pet 页面空闲降帧
