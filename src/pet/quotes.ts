/**
 * 语录池与工具函数。
 * （语录本体定义在 types.ts，这里只放取词工具，避免与状态机互相 import 常量。）
 */

export { CLICK_QUOTES, REMIND_MICRO_QUOTES, REMIND_LONG_QUOTES, HAPPY_QUOTES, POSTPONE_QUOTES, SKIP_QUOTES, PAUSED_QUOTES, RESUMED_QUOTES, PARTY_QUOTES } from "./types";

/** 从语录池随机取一条（池为空时返回空串，调用方按需处理） */
export function pick(pool: readonly string[]): string {
  if (pool.length === 0) return "";
  return pool[Math.floor(Math.random() * pool.length)]!;
}
