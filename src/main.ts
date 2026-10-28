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
  progress: document.getElementById("progress-fill") as HTMLElement,
  saveHint: document.getElementById("save-hint") as HTMLElement,
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

/** phase 枚举 → 中文（对应 scheduler.rs 的 Phase） */
const PHASE_LABELS: Record<string, string> = {
  none: "未在计时",
  StartMicrobreakNotification: "微休息即将开始",
  StartMicrobreak: "微休息中",
  FinishMicrobreak: "微休息结束",
  StartBreakNotification: "长休息即将开始",
  StartBreak: "长休息中",
  FinishBreak: "长休息结束",
  ResumeBreaks: "恢复计时",
};

/** 渲染顶部状态条（直接用事件快照） */
function renderStatus(st: StatusPayload): void {
  // 记录快照与到达时间，供本地插值（planner 只在切换时广播，等待期无事件）
  lastStatus = st;
  lastStatusAt = Date.now();
  paintStatus(st, st.remainingMs, st.progressPercent);
}

/** 用快照 + 本地推算的 remaining/progress 重绘状态条 */
function paintStatus(st: StatusPayload, remainingMs: number, progress: number): void {
  const paused = st.paused;
  els.paused.classList.toggle("visible", paused);
  els.progress.style.width = `${Math.min(100, Math.max(0, progress))}%`;

  if (paused) {
    els.phase.textContent = "已暂停";
    els.next.textContent = "";
    els.remaining.textContent = "--:--";
    els.progress.style.width = "0%";
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
}

/** 开关控制子行显隐：data-dep="microbreak" 之类 */
function updateDepRows(key: string): void {
  const src = document.querySelector<HTMLInputElement>(`[data-setting="${key}"][type="checkbox"]`);
  if (!src) return;
  document.querySelectorAll<HTMLElement>(`[data-dep="${key}"]`).forEach((row) => {
    row.classList.toggle("dimmed", !src.checked);
  });
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
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    }
  }
}

/** 入口 */
async function main(): Promise<void> {
  bindForm();
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
  window.setInterval(interpolateTick, 500);

  // 窗口隐藏时保底解绑（X 只隐藏不销毁，通常无需清理；这里防御性处理）
  window.addEventListener("pagehide", () => unlisten?.());
}

void main();
