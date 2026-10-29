/**
 * 设置页逻辑：加载/编辑设置 + 顶部状态条（监听 "status" 事件）
 * - 设置修改 → debounce 400ms → invoke("update_settings", { patch })
 * - 时长输入用「分钟/秒」友好单位，内部换算 ms
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 后端设置 JSON（camelCase，键名与 settings.rs 一致；petPosX/petPosY 不在 UI 暴露） */
interface Settings {
  microbreak: boolean;
  microbreakDuration: number;
  microbreakInterval: number;
  microbreakNotification: boolean;
  microbreakNotificationInterval: number;
  microbreakPostpone: boolean;
  microbreakPostponeTime: number;
  microbreakPostponesLimit: number;
  microbreakStrictMode: boolean;
  break: boolean;
  breakDuration: number;
  breakInterval: number;
  breakNotification: boolean;
  breakNotificationInterval: number;
  breakPostpone: boolean;
  breakPostponeTime: number;
  breakPostponesLimit: number;
  breakStrictMode: boolean;
  naturalBreaks: boolean;
  naturalBreaksInactivityResetTime: number;
  naturalBreaksCheckInterval: number;
  fullscreen: boolean;
  allScreens: boolean;
  petEnabled: boolean;
  petSkin: string;
}

/** status 事件 payload（planner.rs status()） */
interface StatusPayload {
  phase: string;
  remainingMs: number;
  progressPercent: number;
  paused: boolean;
  breakNumber: number;
  postpones: number;
  nextBreakKind: string | null;
}

/** data-unit 换算：输入值 → ms */
const UNIT_TO_MS: Record<string, number> = {
  sec: 1000,
  min: 60_000,
};

/** debounce 间隔（ms） */
const SAVE_DEBOUNCE_MS = 400;

/** 「已保存」提示停留时长（ms） */
const SAVED_HINT_MS = 1500;

/** 待保存补丁（键 → 值）；timer 句柄 */
const pendingPatch = new Map<string, boolean | number | string>();
let saveTimer: number | undefined;

/** DOM 引用 */
const els = {
  phase: document.getElementById("status-phase") as HTMLElement,
  next: document.getElementById("status-next") as HTMLElement,
  remaining: document.getElementById("status-remaining") as HTMLElement,
  paused: document.getElementById("status-paused") as HTMLElement,
  saveHint: document.getElementById("save-hint") as HTMLElement,
  strip: document.getElementById("cycle-strip") as HTMLElement,
  caption: document.getElementById("cycle-caption") as HTMLElement,
  biMinus: document.getElementById("bi-minus") as HTMLButtonElement,
  biPlus: document.getElementById("bi-plus") as HTMLButtonElement,
  biNum: document.getElementById("bi-num") as HTMLElement,
};

let savedHintTimer: number | undefined;

/** 显示「已保存」提示（顶部状态条） */
function showSavedHint(): void {
  els.saveHint.classList.add("visible");
  window.clearTimeout(savedHintTimer);
  savedHintTimer = window.setTimeout(() => els.saveHint.classList.remove("visible"), SAVED_HINT_MS);
}

/** 把 pendingPatch 发给后端（浅合并 + 落盘） */
async function flushPatch(): Promise<void> {
  if (pendingPatch.size === 0) return;
  const patch: Record<string, boolean | number | string> = {};
  for (const [k, v] of pendingPatch) patch[k] = v;
  pendingPatch.clear();
  try {
    await invoke("update_settings", { patch });
    showSavedHint();
  } catch (e) {
    // 保存失败：提示用户（不打断编辑流）
    els.saveHint.textContent = "保存失败";
    els.saveHint.classList.add("visible", "error");
    window.clearTimeout(savedHintTimer);
    savedHintTimer = window.setTimeout(() => {
      els.saveHint.classList.remove("visible", "error");
      els.saveHint.textContent = "已保存";
    }, SAVED_HINT_MS);
    console.error("update_settings failed:", e);
  }
}

/** 记录一次修改：进 patch、重置 debounce 计时 */
function queueSave(key: string, value: boolean | number | string): void {
  pendingPatch.set(key, value);
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushPatch(), SAVE_DEBOUNCE_MS);
}

/** ms → mm:ss 文本 */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * phase 枚举 → 中文（对应 scheduler.rs 的 Phase）。
 * 注意：planner 在切换时就广播新阶段（先挂新 deadline 再 announce），
 * 所以这些文案描述的是「正在进行的阶段」：
 *   StartXNotification / StartX = 下一次休息的等待期（含通知期）
 *   FinishX = 休息进行中
 */
const PHASE_LABELS: Record<string, string> = {
  none: "未在计时",
  StartMicrobreakNotification: "工作中",
  StartMicrobreak: "工作中",
  FinishMicrobreak: "微休息中",
  StartBreakNotification: "工作中",
  StartBreak: "工作中",
  FinishBreak: "长休息中",
  ResumeBreaks: "恢复计时",
};

/** 渲染顶部状态条（直接用事件快照） */
function renderStatus(st: StatusPayload): void {
  // 记录快照与到达时间，供本地插值（planner 只在切换时广播，等待期无事件）
  lastStatus = st;
  lastStatusAt = Date.now();
  paintStatus(st, st.remainingMs, st.progressPercent);
  renderCycle();
}

/** 用快照 + 本地推算的 remaining/progress 重绘状态条与时间轴游标 */
function paintStatus(st: StatusPayload, remainingMs: number, progress: number): void {
  const paused = st.paused;
  els.paused.classList.toggle("visible", paused);

  // 游标跟随当前段内进度（插值 tick 也走这里；暂停时隐藏）
  if (cursorEl) {
    cursorEl.style.opacity = paused ? "0" : "1";
    if (!paused) cursorEl.style.left = `${Math.min(100, Math.max(0, progress))}%`;
  }

  if (paused) {
    els.phase.textContent = "已暂停";
    els.next.textContent = "";
    els.remaining.textContent = "--:--";
    return;
  }

  // 阶段文案
  els.phase.textContent = PHASE_LABELS[st.phase] ?? st.phase;

  // 下次休息类型
  const kindMap: Record<string, string> = { micro: "微休息", long: "长休息" };
  els.next.textContent = st.nextBreakKind ? `下次：${kindMap[st.nextBreakKind] ?? st.nextBreakKind}` : "";

  // 剩余时间（通知阶段显示的是"距休息开始"，休息阶段显示"距休息结束"）
  els.remaining.textContent = formatClock(remainingMs);
}

/**
 * 本地插值：两次 status 事件之间（等待期可达数分钟无广播），
 * 按挂钟推进剩余时间与进度条，下一个事件到来时自动校正。
 * 推导：pct = elapsed/total 且 remaining = total-elapsed → total = remaining/(1-pct)
 */
let lastStatus: StatusPayload | null = null;
let lastStatusAt = 0;

function interpolateTick(): void {
  if (!lastStatus || lastStatus.paused) return;
  const elapsed = Date.now() - lastStatusAt;
  if (elapsed <= 0) return;
  const remainingMs = Math.max(0, lastStatus.remainingMs - elapsed);
  const pct0 = Math.min(99.9, Math.max(0, lastStatus.progressPercent));
  const total = lastStatus.remainingMs / (1 - pct0 / 100);
  const progress = total > 0 ? 100 * (1 - remainingMs / total) : 0;
  paintStatus(lastStatus, remainingMs, progress);
}

/** 用后端返回的设置填充表单（时长按单位反算） */
function fillForm(s: Settings): void {
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-setting]");
  for (const el of inputs) {
    const key = el.dataset.setting as string;
    const raw = (s as unknown as Record<string, unknown>)[key];
    if (raw === undefined) continue;

    if (el instanceof HTMLSelectElement) {
      el.value = String(raw);
    } else if (el.type === "checkbox") {
      el.checked = Boolean(raw);
    } else if (el.type === "number") {
      const unit = el.dataset.unit;
      const factor = unit ? UNIT_TO_MS[unit] : 1;
      const ms = Number(raw);
      const v = factor ? ms / factor : ms;
      el.value = String(Math.round(v));
    }
    // 联动子行显隐
    updateDepRows(key);
  }
  // breakInterval 不再是数字输入：单独同步步进器，并首绘节奏时间轴
  setBreakInterval(s.breakInterval, false);
  renderCycle();
}

/** 休息节奏行（开关在行内）：关闭时压暗整行文字与控件，但开关保持可点 */
const RHYTHM_ROWS: Record<string, string> = {
  microbreak: "row-microbreak",
  break: "row-break",
};

/** 开关控制子行显隐：data-dep="microbreak" 之类 */
function updateDepRows(key: string): void {
  const src = document.querySelector<HTMLInputElement>(`[data-setting="${key}"][type="checkbox"]`);
  if (!src) return;
  document.querySelectorAll<HTMLElement>(`[data-dep="${key}"]`).forEach((row) => {
    row.classList.toggle("dimmed", !src.checked);
  });
  const rowId = RHYTHM_ROWS[key];
  if (rowId) document.getElementById(rowId)?.classList.toggle("off", !src.checked);
}

/* ============ 休息节奏：循环时间轴 ============ */

/** breakInterval 的 UI 状态（步进器范围 1–10；不再走数字输入，单独与后端同步） */
let breakIntervalValue = 2;

/** 更新步进器显示与可用态；save=true 时入队保存 */
function setBreakInterval(value: number, save: boolean): void {
  breakIntervalValue = Math.min(10, Math.max(1, Math.round(value) || 1));
  els.biNum.textContent = String(breakIntervalValue);
  els.biMinus.disabled = breakIntervalValue <= 1;
  els.biPlus.disabled = breakIntervalValue >= 10;
  if (save) queueSave("breakInterval", breakIntervalValue);
}

/** 从表单读当前节奏设置（以 DOM 为准，改数字即时反映到时间轴） */
function readCycleVals(): { micro: boolean; long: boolean; mi: number; md: number; bd: number; n: number } {
  const num = (key: string): number => {
    const el = document.querySelector<HTMLInputElement>(`[data-setting="${key}"]`);
    const v = el ? Number(el.value) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const flag = (key: string): boolean => {
    const el = document.querySelector<HTMLInputElement>(`[data-setting="${key}"][type="checkbox"]`);
    return el ? el.checked : false;
  };
  return {
    micro: flag("microbreak"),
    long: flag("break"),
    mi: num("microbreakInterval"),
    md: num("microbreakDuration"),
    bd: num("breakDuration"),
    n: breakIntervalValue,
  };
}

/** 循环总时长（分钟）→ 摘要文案 */
function formatRoundMinutes(min: number): string {
  return min >= 1 ? `约 ${Math.round(min)} 分钟` : `不足 1 分钟`;
}

/** 「现在」游标元素（renderCycle 重建后重新指向；插值 tick 只更新 left，不重建 DOM） */
let cursorEl: HTMLElement | null = null;

/** 重画循环时间轴 + 摘要行（加载 / 输入变化 / status 事件时调用） */
function renderCycle(): void {
  const v = readCycleVals();
  cursorEl = null;

  if (!v.micro && !v.long) {
    els.strip.innerHTML = `<div class="cycle-empty">💤 休息已关闭 —— 小鹦鹉会一直陪着你工作</div>`;
    els.caption.innerHTML = `<span class="dot">●</span> 两类休息都未启用，可随时打开下面的开关`;
    return;
  }

  // planner 状态 → 当前段。等待期 breakNumber 即即将到来的第几个休息
  // （next_break 先自增再挂 deadline），当前段 = 其前面的工作段；
  // 休息进行中当前段 = 休息段本身（下一次休息自然就是紧邻的下一个块）。
  // 一轮周期 = n+1 个休息，第 n+1 个为长休息。
  const st = lastStatus;
  let cur: { kind: "work" | "micro" | "long"; idx: number } | null = null; // 「当前」段（游标）
  if (st && !st.paused && st.phase !== "none") {
    const inBreak = st.phase === "FinishMicrobreak" || st.phase === "FinishBreak";
    const period = v.n + 1;
    const posOf = (r: number): number => ((r - 1) % period) + 1;
    if (v.micro && v.long) {
      cur = inBreak
        ? posOf(st.breakNumber) === period
          ? { kind: "long", idx: 0 }
          : { kind: "micro", idx: posOf(st.breakNumber) }
        : { kind: "work", idx: posOf(st.breakNumber) };
    } else {
      cur = inBreak ? (v.micro ? { kind: "micro", idx: 1 } : { kind: "long", idx: 0 }) : { kind: "work", idx: 1 };
    }
  }
  // 游标以 status 自带的段内进度起步（之后由插值 tick 平滑推进）；
  // 上方「当前」小标签随游标一起滑动
  const curHtml = (kind: "work" | "micro" | "long", idx: number): string => {
    if (!cur || cur.kind !== kind || cur.idx !== idx) return "";
    const pct = st ? Math.min(100, Math.max(0, st.progressPercent)) : 0;
    return `<span class="cursor" style="left:${pct}%"><span class="cursor-tag">当前</span></span>`;
  };
  const curCls = (kind: "work" | "micro" | "long", idx: number): string =>
    cur && cur.kind === kind && cur.idx === idx ? " current" : "";
  const LOOP_HTML = `<div class="seg seg-loop"><span class="loop-icon">↻</span><span class="loop-text">循环</span></div>`;
  const workSeg = (idx: number): string =>
    `<div class="seg seg-work${curCls("work", idx)}">${curHtml("work", idx)}<span class="seg-name">工作</span><span class="seg-val">${v.mi} 分钟</span></div>`;

  if (v.micro && v.long) {
    let html = "";
    for (let i = 1; i <= v.n; i++) {
      html += workSeg(i);
      html += `<div class="seg seg-micro${curCls("micro", i)}">${curHtml("micro", i)}<span class="ord">${i}</span><span class="seg-name">微休息</span><span class="seg-val">${v.md} 秒</span></div>`;
    }
    html += workSeg(v.n + 1);
    html += `<div class="seg seg-long${curCls("long", 0)}">${curHtml("long", 0)}<span class="seg-name">长休息</span><span class="seg-val">${v.bd} 分钟</span></div>`;
    els.strip.innerHTML = html + LOOP_HTML;
    const roundMin = (v.n + 1) * v.mi + (v.n * v.md) / 60 + v.bd;
    els.caption.innerHTML = `<span class="dot">●</span> 一个循环 = ${v.n} 次微休息 + 1 次长休息，<b>${formatRoundMinutes(roundMin)}</b>，然后重新开始`;
  } else if (v.micro) {
    els.strip.innerHTML =
      workSeg(1) +
      `<div class="seg seg-micro${curCls("micro", 1)}">${curHtml("micro", 1)}<span class="ord">1</span><span class="seg-name">微休息</span><span class="seg-val">${v.md} 秒</span></div>` +
      LOOP_HTML;
    els.caption.innerHTML = `<span class="dot">●</span> 只安排微休息：每工作 ${v.mi} 分钟休息 ${v.md} 秒，一直循环`;
  } else {
    const every = v.mi * (v.n + 1);
    els.strip.innerHTML =
      workSeg(1) +
      `<div class="seg seg-long${curCls("long", 0)}">${curHtml("long", 0)}<span class="seg-name">长休息</span><span class="seg-val">${v.bd} 分钟</span></div>` +
      LOOP_HTML;
    els.caption.innerHTML = `<span class="dot">●</span> 只安排长休息：每 <b>${every} 分钟</b>（${v.mi} 分钟 × ${v.n + 1}）休息 ${v.bd} 分钟`;
  }

  cursorEl = els.strip.querySelector<HTMLElement>(".seg .cursor");
}

/** 绑定所有输入：change/input → queueSave */
function bindForm(): void {
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-setting]");
  for (const el of inputs) {
    if (el instanceof HTMLSelectElement) {
      el.addEventListener("change", () => {
        queueSave(el.dataset.setting as string, el.value);
      });
    } else if (el.type === "checkbox") {
      el.addEventListener("change", () => {
        queueSave(el.dataset.setting as string, el.checked);
        updateDepRows(el.dataset.setting as string);
        renderCycle();
      });
    } else if (el.type === "number") {
      const handler = (): void => {
        const key = el.dataset.setting as string;
        const unit = el.dataset.unit;
        const factor = unit ? UNIT_TO_MS[unit] : 1;
        const parsed = Number(el.value);
        if (!Number.isFinite(parsed)) return;
        const clamped = Math.min(Number(el.max), Math.max(Number(el.min), parsed));
        queueSave(key, Math.round(clamped * factor));
        renderCycle();
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    }
  }
  // 「每 N 次微休息」步进器
  els.biMinus.addEventListener("click", () => {
    setBreakInterval(breakIntervalValue - 1, true);
    renderCycle();
  });
  els.biPlus.addEventListener("click", () => {
    setBreakInterval(breakIntervalValue + 1, true);
    renderCycle();
  });
}

/** 入口 */
async function main(): Promise<void> {
  bindForm();
  // 先按 HTML 默认值画出节奏时间轴（后端加载前也有完整首屏）
  renderCycle();
  // 加载设置并填充表单
  try {
    const s = await invoke<Settings>("get_settings");
    fillForm(s);
  } catch (e) {
    console.error("get_settings failed:", e);
    els.phase.textContent = "设置加载失败";
  }

  // 状态条：监听 status 事件实时刷新；事件间隙用 500ms 本地插值（planner 等待期不广播）
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<StatusPayload>("status", (ev) => renderStatus(ev.payload));
  } catch (e) {
    console.error("listen status failed:", e);
  }
  // 打开页面时主动拉一次快照立即渲染——否则等待期无广播，占位符会挂到下一次阶段切换
  try {
    const snapshot = await invoke<StatusPayload | null>("get_status");
    if (snapshot && typeof snapshot.phase === "string") {
      renderStatus(snapshot);
    }
  } catch (e) {
    console.error("get_status failed:", e);
  }
  window.setInterval(interpolateTick, 500);

  // 窗口隐藏时保底解绑（X 只隐藏不销毁，通常无需清理；这里防御性处理）
  window.addEventListener("pagehide", () => unlisten?.());
}

void main();
