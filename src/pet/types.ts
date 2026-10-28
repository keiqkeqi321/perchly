/**
 * 桌宠状态机的类型定义与后端事件契约。
 * 后端约定：
 *  - "planner" 事件：payload = { type: string, data: any }
 *  - "status"  独立事件：payload = 状态对象（这里做了兼容，{data: 状态对象} 也能识别）
 */

/** 基态：决定鹦鹉整体表现（挂 class: is-xxx） */
export type BaseState = "idle" | "sleepy" | "remind" | "happy";

/** 瞬时动作：短暂叠加在基态之上（挂 class: act-xxx）。
 *  注：spin（根节点整周旋转）已随"去除根节点旋转动画"移除。 */
export type TransientAction = "blink" | "tilt" | "yawn" | "stomp" | "party";

/** "status" 事件 payload */
export interface StatusPayload {
  phase: string;
  remainingMs: number;
  progressPercent: number; // 0-100
  paused: boolean;
  breakNumber: number;
  postpones: number;
  nextBreakKind: "Micro" | "Long" | null;
}

/** "planner" 事件 payload */
export interface PlannerEvent {
  type: string;
  data?: unknown;
}

/** *-finished 事件（micro-finished / long-finished）的 data */
export interface FinishedData {
  skipped?: boolean;
  postponed?: boolean;
}

/** 类型守卫：判断是否为 *-finished 的 data */
export function isFinishedData(v: unknown): v is FinishedData {
  if (typeof v !== "object" || v === null) return false;
  const rec = v as Record<string, unknown>;
  return typeof rec.skipped === "boolean" || typeof rec.postponed === "boolean";
}

/**
 * 把 unknown 归一化为 StatusPayload；兼容裸对象与 {data: {...}} 两种形状。
 * 无法识别时返回 null（调用方直接忽略该事件）。
 */
export function asStatus(v: unknown): StatusPayload | null {
  const outer = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  if (!outer) return null;
  const rec =
    "phase" in outer
      ? outer
      : typeof outer.data === "object" && outer.data !== null
        ? (outer.data as Record<string, unknown>)
        : null;
  if (!rec || typeof rec.phase !== "string" || typeof rec.remainingMs !== "number") return null;
  return {
    phase: rec.phase,
    remainingMs: rec.remainingMs,
    progressPercent: typeof rec.progressPercent === "number" ? rec.progressPercent : 0,
    paused: rec.paused === true,
    breakNumber: typeof rec.breakNumber === "number" ? rec.breakNumber : 0,
    postpones: typeof rec.postpones === "number" ? rec.postpones : 0,
    nextBreakKind: rec.nextBreakKind === "Micro" || rec.nextBreakKind === "Long" ? rec.nextBreakKind : null,
  };
}

/* =========================================================
 * 语录池（中文 · 可爱风）
 * ========================================================= */

/** 点击身体随机说话池（≥8 条） */
export const CLICK_QUOTES: readonly string[] = [
  "啾～戳我干嘛！",
  "咕咕咕～陪我玩会儿嘛！",
  "站了一天，脚趾都麻啦！",
  "我的冠羽今天好看吗？",
  "喝水了吗？我盯着你呢！",
  "啾啾！记得抬头放松脖子哦～",
  "哼，再戳就要掉毛啦！",
  "主人写代码的样子最帅了！",
  "摸鱼五分钟，快乐一整天～",
  "嘘……我帮你盯着休息时间！",
];

/** micro 休息提醒 */
export const REMIND_MICRO_QUOTES: readonly string[] = ["该休息啦！", "小休息时间到！眨眨眼～"];
/** long 休息提醒 */
export const REMIND_LONG_QUOTES: readonly string[] = ["大休息到啦！起来走走～", "长休息时间！站起来晃晃～"];
/** 休息开始（happy） */
export const HAPPY_QUOTES: readonly string[] = ["休息真棒～", "伸个懒腰，舒服！", "喝水啦喝水啦～"];
/** 推迟休息（postponed → 跺脚） */
export const POSTPONE_QUOTES: readonly string[] = ["推迟休息？哼！跺脚！", "再拖就啄你小脑袋！", "哼，本鸟生气了！"];
/** 跳过休息（skipped） */
export const SKIP_QUOTES: readonly string[] = ["跳过休息…身体要紧呀！", "呜，又不休息……"];
/** 计时暂停 */
export const PAUSED_QUOTES: readonly string[] = ["计时暂停，我先眯一会儿～", "暂停就小睡片刻 zzz"];
/** 计时恢复 */
export const RESUMED_QUOTES: readonly string[] = ["继续加油！我盯着你哦～", "开工开工，啾！"];
/** 连击彩蛋（派对帽） */
export const PARTY_QUOTES: readonly string[] = ["派对时间！啾啾——！", "哇！帽子好看吗？"];
