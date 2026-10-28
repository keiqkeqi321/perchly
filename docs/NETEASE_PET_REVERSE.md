# 网易云音乐桌面宠物动画格式逆向分析

> 分析日期：2026-10-28 · 对象：D:\APP\CloudMusic（CEF/Chromium 架构 PC 版）
> 起因：Perchly 桌宠技术选型参考。

## 结论（TL;DR）

**网易云桌宠 = CEF 离屏渲染(OSR)透明窗口 + WebM(VP9) 带 Alpha 短视频循环**，由 C++ 原生插件 `DesktopPet` 驱动，**不是 Lottie/SVGA/Spine**。

## 证据链

### 1. 架构层（cloudmusic.dll 字符串逆向）
```
.?AVDesktopPet@plugin@@                       → C++ 原生插件类
.?AVDesktopPetOsrWindow@plugin@@              → OSR(离屏渲染)窗口
.?AVDesktopPetClickThroughController@plugin@@ → 鼠标穿透控制器
D:\jenkins\...\desktop_pet\desktop_pet_osr_window.cpp
[DesktopPetOSR] Create skipped, window already exists.
[DesktopPet] Click canceled (drag took effect).   ← 点击/拖拽区分逻辑
[DesktopPet] Clamp into screen (keep >=1/2 visible) ← 防拖出屏幕
[DesktopPet] WM_DPICHANGED dpi:                ← 多 DPI 适配
[DesktopPet] OSR window Create failed, falling back to windowed.
```
→ 与 Perchly 的 Tauri 透明窗口方案本质相同：网页渲染 → 分层窗口合成 → 点击穿透按需开合。

### 2. 资源层（Statics 皮肤缓存目录）
`%LOCALAPPDATA%\Netease\CloudMusic\Statics\*.dat` 共 13k+ 文件：
- WEBP 8133 / JPEG 5078 / PNG 89（页面与皮肤图）
- **28 个 WebM 视频**（魔数 1A45DFA3），ffprobe 解析：

| 分辨率 | 编码 | 帧率 | 时长 | 像素格式 |
|---|---|---|---|---|
| 640x640 / 960x960 / 1080x1080 / **1440x1440** | **VP9** | 23-29fps | **3.5~4s 循环** | yuv420p |

- 尺寸规律：正方形、多档分辨率（按屏幕 DPR 选档）、约 4 秒一个动作循环 —— 典型桌宠动作切片（待机/跳舞/睡觉/点击反应各一条）。
- 样本已导出至本目录（*.dat.webm + preview*.gif）。
- 注：yuv420p 无 Alpha。**透明合成方式推测**：播放时用 chroma-key 抠像（纯色背景 key 掉）或 `mix-blend-mode`/CSS mask 处理——视频本体不带 alpha 通道。

### 3. 其他排除项
- `resource/3D环绕.ncae`、aioresource 的 model_192k：魔数 `NCAE`（网易自研加密压缩格式），但内容是音频处理模型（192k/96k 码率档），与桌宠无关。
- CEF 磁盘缓存中的 gzip JS 里无 svga/lottie/桌宠关键词 → 网页层没有矢量动画播放器。
- LocalStorage 中的桌宠配置经 base64+AES 加密（无法直接读）。

## 对 Perchly 的启示

1. **当前 SVG+CSS 方案内存更优**：网易云选 WebM 视频是美术生产效率优先（AE/PR 直接导出）；Perchly 用 SVG 状态机是渲染开销最小路线（无视频解码线程），两者取舍不同。
2. **若未来要美术级动作**：备选路线是 **VP9/WebM + yuva420p（带 Alpha）**——Tauri 的 WebView 直接 `<video>` 播放即可透明合成（WebView2/WKWebView 都支持 VP9 alpha）。比网易云的 chroma-key 方案更干净。
3. **动作切片规范可借鉴**：每动作 3~4s 循环、正方形、多分辨率按 DPI 选档（640/960/1080/1440）。
4. **交互细节已印证**：点击 vs 拖拽区分（拖拽生效则取消点击）、位置钳制（至少留一半在屏内）、DPI 变化处理——与 Perchly pointer.ts 已实现的行为一致。
