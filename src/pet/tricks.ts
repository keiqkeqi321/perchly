/**
 * 瞬时动作管理器（act-xxx class）+ 说话气泡。
 *
 * 负责：
 *  - idle 随机小动作：每 3~6s 随机眨眼 / 偶尔歪头
 *  - sleepy 定时打哈欠
 *  - 点击反应（歪头/转圈/说话）由 pointer 层调用 playAction()
 *  - 气泡：show(text, duration)，到时自动淡出；同一时间只有一条
 *
 * 实现要点：不跑 rAF，全部 setTimeout；连续动作若同名则先取消旧的再放新的。
 */

import type { PetDom } from "./dom";
import type { TransientAction } from "./types";

/** 各动作的一次播放时长（ms）：到期后移除 class，元素回落到基态表现 */
const ACTION_MS: Readonly<Record<TransientAction, number>> = {
  blink: 130,
  tilt: 900,
  yawn: 1000,
  spin: 800,
  stomp: 1100, // 动画播 2 遍
  party: 6000, // 彩蛋派对帽驻留久一点
};

/** 气泡默认驻留 */
const BUBBLE_MS = 3200;

export interface TrickManager {
  /** 播放一次瞬时动作（同名动作重复触发时重置计时） */
  playAction(action: TransientAction): void;
  /** 重排 idle 随机小动作定时器（进入/离开 idle、基态切换时调用） */
  scheduleIdleFidgets(): void;
  /** 重排/停止 sleepy 打哈欠定时器 */
  scheduleYawns(active: boolean): void;
  /** 展示气泡；showOnly=true 表示替换当前气泡（默认行为） */
  showBubble(text: string, durationMs?: number): void;
  /** 清理全部定时器（页面卸载时用） */
  dispose(): void;
}

export function createTrickManager(dom: PetDom): TrickManager {
  const stage = dom.stage;

  const actionTimer = new Map<TransientAction, number>();
  let fidgetTimer = 0;
  let yawnTimer = 0;
  let bubbleTimer = 0;
  let disposed = false;

  /* ---------- 瞬时动作 ---------- */
  function playAction(action: TransientAction): void {
    if (disposed) return;
    const prev = actionTimer.get(action);
    if (prev !== undefined) window.clearTimeout(prev);

    // stomp / party 若正在播放先摘掉再重挂，保证 animation 重触发
    stage.classList.remove(`act-${action}`);
    // 强制同步 reflow，重启动画
    void stage.offsetWidth;
    stage.classList.add(`act-${action}`);

    const ms = ACTION_MS[action];
    const t = window.setTimeout(() => {
      stage.classList.remove(`act-${action}`);
      actionTimer.delete(action);
    }, ms);
    actionTimer.set(action, t);
  }

  /* ---------- idle 随机小动作：每 3~6s ---------- */
  function scheduleIdleFidgets(): void {
    if (disposed) return;
    window.clearTimeout(fidgetTimer);
    const delay = 3000 + Math.random() * 3000; // 3000~6000ms
    fidgetTimer = window.setTimeout(() => {
      if (disposed) return;
      // 70% 眨眼，30% 歪头
      if (Math.random() < 0.7) playAction("blink");
      else playAction("tilt");
      scheduleIdleFidgets(); // 链式重排
    }, delay);
  }

  /* ---------- sleepy 打哈欠：每 8~14s 一次 ---------- */
  function scheduleYawns(active: boolean): void {
    window.clearTimeout(yawnTimer);
    if (!active || disposed) return;
    const delay = 8000 + Math.random() * 6000;
    yawnTimer = window.setTimeout(() => {
      if (disposed) return;
      playAction("yawn");
      scheduleYawns(true);
    }, delay);
  }

  /* ---------- 气泡 ---------- */
  function showBubble(text: string, durationMs: number = BUBBLE_MS): void {
    if (disposed) return;
    window.clearTimeout(bubbleTimer);
    dom.bubbleText.textContent = text;
    dom.bubble.classList.add("show");
    bubbleTimer = window.setTimeout(() => {
      dom.bubble.classList.remove("show");
    }, durationMs);
  }

  return {
    playAction,
    scheduleIdleFidgets,
    scheduleYawns,
    showBubble,
    dispose(): void {
      disposed = true;
      window.clearTimeout(fidgetTimer);
      window.clearTimeout(yawnTimer);
      window.clearTimeout(bubbleTimer);
      for (const t of actionTimer.values()) window.clearTimeout(t);
      actionTimer.clear();
    },
  };
}
