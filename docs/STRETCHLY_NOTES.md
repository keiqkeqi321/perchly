# Stretchly 源码学习笔记 → Perchly 移植指南

> 学习对象：`~/Projects/stretchly`（v1.22.1, Electron, BSD-2-Clause）
> 本文档是 Perchly 调度器的**移植依据**，所有行为对齐以此为准。

## 1. Scheduler（app/utils/scheduler.js）—— 最小定时器

```js
class Scheduler {
  constructor (func, delay, reference = null) { this.timer = null; this.delay = delay; this.func = func; this.reference = reference }
  get timeLeft () { return this.now + this.delay - Date.now() }   // 挂钟时间换算
  plan () { this.now = Date.now(); this.timer = setTimeout(this.func, this.delay) }
  correct () { clearTimeout(this.timer); this.timer = setTimeout(this.func, this.timeLeft) }  // 系统唤醒后重挂
}
```

**要点**
- 单一活动定时器，`reference` 字符串标记当前阶段（见 §2），是所有中断守卫的依据。
- `timeLeft` 用 `Date.now()` 挂钟差值计算，**不是**剩余 timeout。
- `correct()`：系统睡眠/唤醒后定时器会漂移或瞬间触发，powerMonitor `resume` 事件时调用它按剩余时间重新挂表。

**Perchly 移植（scheduler.rs）**
- `struct Deadline { phase: Phase, at: SystemTime }`，tokio task `sleep_until(deadline)`。
- Phase 用 enum：`StartMicrobreakNotification / StartMicrobreak / FinishMicrobreak / StartBreakNotification / StartBreak / FinishBreak / ResumeBreaks`（对齐 reference 语义）。
- ⚠️ 不要用 `Instant`：部分平台上睡眠期间单调钟不走，且拿不到"真实过了多久"；用 `SystemTime` + tauri `RunEvent::Resumed` 时按 `now()` 与 deadline 差值重挂（等价 correct()）。

## 2. BreaksPlanner 状态机（app/breaksPlanner.js）—— 全软件最核心的 330 行

### 2.1 事件流（EventEmitter）
`startMicrobreakNotification → startMicrobreak → microbreakStarted → finishMicrobreak → nextBreak...`
长休息同构：`startBreakNotification → startBreak → breakStarted → finishBreak`。

### 2.2 nextBreak() 交错逻辑
- 微休息+长休息都开：每周期 `breakNumber += 1`；当 `breakNumber % (breakInterval + 1) == 0` → 长休息，否则微休息。
- 只有微休息：interval 到点直接 startMicrobreak。
- 只有长休息：到点 `interval * (breakInterval + 1)` 后 startBreak。
- 通知模式：若开启前置通知，定时器挂到 `interval - notificationInterval`，触发后再挂 `notificationInterval` 才真正开始休息（`nextBreakAfterNotification()`）。

### 2.3 postponeCurrentBreak()
- `postponesNumber += 1`；若 `postponeTime > notificationInterval` 且通知开启 → 回到通知阶段（差值），否则完整 postponeTime 后直接 start。
- postponeTime 可为负？不——Stretchly 保证 settings 约束，我们也要在 settings 校验。

### 2.4 skipToMicrobreak(delay=100) / skipToBreak(delay=100)
- skipToMicrobreak：若 `breakNumber % breakInterval == 0` 则设 `breakNumber = 1`（避免下一个还是长休息），100ms 后 startMicrobreak。
- skipToBreak：`breakNumber = breakInterval`（使下周期取模=0 → 长休息），100ms 后 startBreak。
- **手动跳过必须改 breakNumber**，否则交错计数错乱 —— 移植时最容易丢的细节。

### 2.5 pause / resume / clear
- `clear()`：cancel + breakNumber=0 + postponesNumber=0。
- `pause(ms)`：clear + isPaused=true + **停掉三个 poller**（idle/DND/appExclusion）；`ms != 1` 时挂 resumeBreaks 定时器（ms==1 表示无限期暂停）。
- `resume()`：cancel + nextBreak() 重排 + 恢复 pollers。

### 2.6 中断守卫（所有外部事件统一套路）
空闲清除 / DND 开始等事件触发时必须检查：
`reference !== 'finishMicrobreak' && reference !== 'finishBreak'`
即**正在进行的休息不被打断**（例外：appExclusion 'pause' 规则会先 `finishBreak(false,false)` 再 clear）。
参考 breaksPlanner.js L33-110 的一整套守卫链，逐条移植到 `planner.rs` 的 match。

### 2.7 给托盘用的
- `timeToNextBreak`：reference 是 startXxx → timeLeft；是 startXxxNotification → timeLeft + notificationInterval。
- `progressPercentage = 1 - remaining/total`（total 含通知段）。

## 3. NaturalBreaksManager（app/utils/naturalBreaksManager.js）—— 自然休息

- 每 `naturalBreaksCheckInterval` 轮询一次 idle；idle = `powerMonitor.getSystemIdleTime() || desktopIdle.getIdleTime()`（秒→ms）。
- **三段式**：
  1. idle > 20s → 进入自然休息（不清定时器，只是标记）；
  2. idle > `naturalBreaksInactivityResetTime`（默认 5min）→ `clearBreakScheduler`（用户真在休息，放弃倒计时）；
  3. 恢复活动且上次 idle 超过 resetTime → `naturalBreakFinished` → planner `reset()`（**重置整个周期**，不续旧进度）。

**Perchly 移植（idle.rs）**
- Windows：`GetLastInputInfo`（tick ms，注意 ~49.7 天回绕，用 `(GetTickCount() - info.dwTime)` 差值算）。
- macOS：`CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateCombinedSessionState, ...)`（查询不需要辅助功能权限；只有 EventTap 监听才需要）。
- 轮询间隔跟设置走（默认 10s），空闲时低频，勿高频轮询。

## 4. 全屏遮罩窗口（app/main.js）

- **每个显示器一个窗口**：`screen.getAllDisplays()` + `setBounds` 逐屏放置。
- 平台差异（main.js L899-952, L1069-1123）：
  - 非 macOS：`setFullScreen(fullscreen设置)`；**win32 + fullscreen → `setKiosk`**。
  - macOS：kiosk 全屏独占 Space，`CanJoinAllSpaces` 会把它踢出去（菜单栏回来）→ darwin 上避免组合使用。
- 休息窗口 always-on-top，要压过全屏应用；结束时逐屏关闭。
- **Perchly 移植（overlay.rs）**：tauri `available_monitors()` 逐屏建 `break-<n>` 窗口（visible:false 预建或到点即建，待实测内存后定）；win32 用 `set_fullscreen(true)`；结束逐窗 `close()`。

## 5. 其他机制（后续里程碑参考）

- **DND 监听（dndManager）**：macOS 读 focus mode plist / Windows 读注册表 Quiet Hours —— M4 再做。
- **App 黑名单（appExclusionsManager）**：轮询前台进程名，规则 pause/resume 两种；macOS 取前台应用需要**屏幕录制权限**（成本高，M4 且默认关闭）；Windows `GetForegroundWindow` + 进程名即可。
- **Settings**：JSON 存储 + 大量默认值 + 跨版本迁移字段（`settings.js` 里逐版本 patch），我们 v0.1 只做defaults + 原子写。
- **声音/静音、tip 文案轮换、主题**：UI 层功能，M2+。

## 6. 明确不照抄的部分

| Stretchly 做法 | Perchly 改法 | 原因 |
|---|---|---|
| Electron 常驻多 BrowserWindow | Tauri 三窗口：settings 平时 hidden（或 destroy），pet 常驻，overlay 到点创建 | 内存预算 50-70MB |
| JS 单线程 setTimeout 链 | Rust tokio + SystemTime deadline | 睡眠唤醒鲁棒性 |
| 托盘菜单纯文本状态 | 托盘 + 桌宠表情双反馈 | 产品差异化 |
| 无桌宠 | pet 窗口订阅 planner 事件 → 状态机 | 核心卖点 |

## 7. 移植验收清单（行为对齐测试）

- [ ] 微/长休息交错计数（breakInterval+1）正确
- [ ] skipToBreak 后紧接 reset/nextBreak 不出现双长休息
- [ ] 睡眠 1 小时唤醒后：剩余时间正确（不立即触发、不清零）
- [ ] 空闲 20s → 自然休息标记；空闲 >5min → 清定时；回来 → 周期重置
- [ ] 正在进行的休息（finish 阶段）不被 idle/DND 事件打断
- [ ] postpone 次数上限、postponeTime 与 notificationInterval 的回退分支
- [ ] 多显示器：每屏一个遮罩，退出后全部关闭
- [ ] 托盘 tooltip 的 timeToNextBreak 含通知段
