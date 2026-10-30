/**
 * 休息遮罩页逻辑：全屏倒计时 + 推迟/跳过 + 结束自隐藏
 * - 加载时 invoke("get_current_break") + invoke("get_settings")（拿 strictMode）
 * - 倒计时用 startedAt + durationMs 本地推算（rAF 驱动，每 ~250ms 刷新 UI）
 * - 收到 "planner" 通道的 micro-finished / long-finished（payload.type）
 *   → 自己 hide（Rust 侧 overlay::hide 也会关，双保险）
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** 当前休息信息（lib.rs BreakInfo，camelCase 序列化；startedAt 为 Unix epoch 毫秒） */
interface CurrentBreak {
  kind: "micro" | "long";
  durationMs: number;
  startedAt: number;
  /** 建窗时后端算好的推迟可用性（开启 && 次数未用尽 && limit>0） */
  canPostpone: boolean;
}

/** 设置 JSON 里本页需要的子集 */
interface BreakSettings {
  microbreakStrictMode: boolean;
  breakStrictMode: boolean;
}

/** "planner" 通道 payload：{ type, data } */
interface PlannerEvent {
  type: string;
  data: unknown;
}

/** 随机休息提示文案：微休息 / 长休息 各一组（每组 10 条） */
const TIPS: Record<"micro" | "long", string[]> = {
  micro: [
    "眨眨眼，看看 6 米外的远方",
    "闭上眼睛，深呼吸三次",
    "转动眼球，顺时针三圈、逆时针三圈",
    "放松肩膀，让双手休息一会儿",
    "轻轻按摩眼眶周围",
    "挺直腰背，调整一下坐姿",
    "远眺窗外，找一棵绿色的树",
    "甩甩手腕，转转脖子",
    "闭上眼，想象一片安静的湖面",
    "微笑一下，哪怕没有理由",
  ],
  long: [
    "站起来，倒一杯温水慢慢喝",
    "离开座位，走动两分钟",
    "伸展双臂，给胸腔一个打开的机会",
    "抬头看看天花板，缓解颈部压力",
    "做十个深蹲或原地踏步",
    "洗把脸，让自己清醒一下",
    "揉揉腰部和后背，放松久坐的肌肉",
    "望向窗外最远的地方，休息眼睛",
    "整理一下桌面，也整理一下思绪",
    "深呼吸：吸气 4 秒，呼气 6 秒，重复五次",
  ],
};

/** 圆环几何：viewBox 260、半径 118 → 周长 = 2πr */
const RING_RADIUS = 118;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** UI 刷新节流间隔（ms）：rAF 每帧回调，每 250ms 才真正重绘 */
const UI_TICK_MS = 250;

/** 已发起隐藏则不再重复（防抖） */
let hiding = false;

/** DOM 引用 */
const els = {
  body: document.body,
  badge: document.getElementById("kind-badge") as HTMLElement,
  countdown: document.getElementById("countdown") as HTMLElement,
  ringProgress: document.querySelector<SVGCircleElement>("#ring-progress")!,
  tip: document.getElementById("tip") as HTMLElement,
  actions: document.getElementById("actions") as HTMLElement,
  postpone: document.getElementById("btn-postpone") as HTMLButtonElement,
  skip: document.getElementById("btn-skip") as HTMLButtonElement,
  kbdHint: document.getElementById("kbd-hint") as HTMLElement,
};

/** ms → m:ss 文本（向上取整到秒） */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 隐藏自己（双保险：Rust 侧 overlay::hide 也会销毁窗口） */
function selfHide(): void {
  if (hiding) return;
  hiding = true;
  getCurrentWindow()
    .hide()
    .catch((e) => console.error("hide window failed:", e));
}

/** 动作节流（400ms）：按钮按可用窗口显隐后，正常点击不会连发；节流只为挡住
 *  按住 Esc 的键盘自动重复。不用「只发一次」的锁——前后端在 30% 边界的取整
 *  口径可能差 1%，若后端恰好拒绝而前端已上锁，按钮就死了。 */
const ACTION_THROTTLE_MS = 400;
let skipSentAt = 0;
let postponeSentAt = 0;

function skipBreak(): void {
  const now = Date.now();
  if (now - skipSentAt < ACTION_THROTTLE_MS) return;
  skipSentAt = now;
  invoke("skip_current").catch((e) => console.error("skip_current failed:", e));
}

/** 推迟当前休息：planner 侧 hide 遮罩并重排计划（同一节流） */
function postponeBreak(): void {
  const now = Date.now();
  if (now - postponeSentAt < ACTION_THROTTLE_MS) return;
  postponeSentAt = now;
  invoke("postpone_break").catch((e) => console.error("postpone_break failed:", e));
}

/** Stretchly 语义（utils.js canSkip/canPostpone，postponableDurationPercent=30）：
 *  - 推迟：仅前 30% 可用；
 *  - 跳过：推迟可用时须过 30%，推迟不可用时全程可用。
 *  按钮可用性随倒计时切换：不可用的按钮直接不显示——点了没反应的按钮
 *  是"跳过按钮不灵敏"的根因（后端守卫静默 return，前端无任何反馈）。 */
const POSTPONABLE_PERCENT = 30;

/** 与后端 skip_current 守卫同口径（progress_percent 为向下取整整数）：
 *  推迟可用时，已过进度 > 30% 才允许跳过；推迟不可用则全程可跳。 */
function canSkipNow(brk: CurrentBreak): boolean {
  if (!brk.canPostpone) return true;
  const elapsedPct = Math.trunc(((Date.now() - brk.startedAt) / brk.durationMs) * 100);
  return elapsedPct > POSTPONABLE_PERCENT;
}

/**
 * 启动倒计时：rAF 驱动、挂钟为时间基准（与 startedAt 同源，睡眠唤醒也正确）
 * 每 ~250ms 重绘一次（数字 + 圆环 stroke-dashoffset），归零时兜底自隐藏
 */
function startCountdown(brk: CurrentBreak): void {
  const endAt = brk.startedAt + brk.durationMs;
  let lastPaint = 0;

  /** 按钮显隐刷新（对齐 Stretchly break-renderer.js 每秒切换 hidden）：
   *  不可用的动作不显示——「跳过」前 30%（推迟可用时）静默无响应是本次修的 bug。 */
  const updateActions = (remainMs: number): void => {
    const elapsedPct = Math.trunc(((brk.durationMs - remainMs) / brk.durationMs) * 100);
    els.postpone.hidden = !(brk.canPostpone && elapsedPct <= POSTPONABLE_PERCENT);
    const skipOk = !brk.canPostpone || elapsedPct > POSTPONABLE_PERCENT;
    els.skip.hidden = !skipOk;
    els.kbdHint.hidden = !skipOk;
  };

  const paint = (): boolean => {
    const remainMs = endAt - Date.now();
    els.countdown.textContent = formatClock(remainMs);
    // 圆环：剩余比例 → dashoffset（剩余越多环越满，随时间消退）
    const frac = Math.min(1, Math.max(0, remainMs / brk.durationMs));
    els.ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - frac));
    // 按钮可用窗口随倒计时切换（对齐 Stretchly break-renderer.js 的每秒显隐）
    updateActions(remainMs);
    return remainMs > 0; // false = 结束，停止循环
  };

  const loop = (): void => {
    const now = Date.now();
    if (now - lastPaint >= UI_TICK_MS) {
      lastPaint = now;
      if (!paint()) {
        // 倒计时归零：正常路径是 Rust 已发 finished 并关窗，这里兜底
        selfHide();
        return;
      }
    }
    requestAnimationFrame(loop);
  };

  // 首帧立即绘制，再进入节流循环
  lastPaint = Date.now();
  if (!paint()) {
    selfHide();
    return;
  }
  requestAnimationFrame(loop);
}

/** 入口 */
async function main(): Promise<void> {
  // 并行拉取当前休息与设置；任一失败都视为异常 → 直接隐藏窗口
  const [brkRes, setRes] = await Promise.allSettled([
    invoke<CurrentBreak | null>("get_current_break"),
    invoke<BreakSettings>("get_settings"),
  ]);

  const brk = brkRes.status === "fulfilled" ? brkRes.value : null;
  const settings = setRes.status === "fulfilled" ? setRes.value : null;

  if (!brk || !settings) {
    // 没有进行中的休息 / 设置读取失败（窗口被误开或后端异常）：直接隐藏
    selfHide();
    return;
  }

  const kind = brk.kind;
  const strict = kind === "micro" ? settings.microbreakStrictMode : settings.breakStrictMode;

  // 主题：long 暖橙 / micro teal（CSS 变量切换）
  els.body.classList.toggle("theme-long", kind === "long");
  els.body.classList.toggle("theme-micro", kind === "micro");
  els.badge.textContent = kind === "long" ? "长休息" : "微休息";

  // 随机提示文案（按 kind 两组，各 10 条）
  const tips = TIPS[kind];
  els.tip.textContent = tips[Math.floor(Math.random() * tips.length)]!;

  // 圆环初始化：满环起步
  els.ringProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  els.ringProgress.style.strokeDashoffset = "0";

  // 严格模式：两个按钮 + 键盘提示都不渲染，也不响应键盘
  if (strict) {
    els.actions.remove();
    els.kbdHint.remove();
  } else {
    // 交互可用性（对齐 Stretchly utils.js canSkip/canPostpone）：
    //  - 推迟：canPostpone（后端已含次数上限）且前 30% 才显示；
    //  - 跳过：推迟不可用时全程显示；推迟可用时 30% 后显示。
    //  不可用的按钮不显示，杜绝「点了没反应」。初始态由 startCountdown 首帧绘制。
    els.postpone.addEventListener("click", postponeBreak);
    els.skip.addEventListener("click", skipBreak);
    // Esc / Ctrl+C = 跳过（与按钮同一可用窗口；不可跳过时不吞按键）
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" || (ev.ctrlKey && ev.key.toLowerCase() === "c")) {
        if (!canSkipNow(brk)) return;
        ev.preventDefault();
        skipBreak();
      }
    });
  }

  // 结束事件 → 自己 hide（双保险）：监听 "planner" 通道的 micro-finished / long-finished
  try {
    await listen<PlannerEvent>("planner", (ev) => {
      if (ev.payload.type === "micro-finished" || ev.payload.type === "long-finished") {
        selfHide();
      }
    });
  } catch (e) {
    console.error("listen planner failed:", e);
  }

  // 倒计时启动（入场淡入 300ms 由 CSS 动画完成）
  startCountdown(brk);
}

void main();
