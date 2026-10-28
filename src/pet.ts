/**
 * pet.html 入口：组装桌宠。
 *
 * 职责拆分：
 *   dom.ts     静态骨架引用
 *   state.ts   基态状态机（is-xxx）
 *   tricks.ts  瞬时动作 + 气泡（act-xxx）
 *   bridge.ts  后端事件 → 状态翻译
 *   pointer.ts 拖拽 / 点击 / 双击 / 鼠标穿透
 *
 * 启动即渲染（DOM 静态写在 pet.html 里，无动态构建），
 * 各异步模块失败时逐个降级，不让桌宠白屏。
 */

import "./styles/pet.css";
import { getPetDom } from "./pet/dom";
import { createStateMachine } from "./pet/state";
import { createTrickManager } from "./pet/tricks";
import { bindEvents } from "./pet/bridge";
import { setupPointer } from "./pet/pointer";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CLICK_QUOTES, PARTY_QUOTES, pick } from "./pet/quotes";

/** 连击彩蛋：连续点击次数（超时窗口内） */
const COMBO_FOR_PARTY = 5;
/** 连击超时窗口：超过该间隔未点击则清零 */
const COMBO_WINDOW_MS = 2500;

function main(): void {
  const dom = getPetDom();

  // 瞬时动作 + 气泡管理器
  const tricks = createTrickManager(dom);

  // 基态状态机（注入 hooks：小动作定时器与气泡都由 tricks 提供）
  const sm = createStateMachine(dom, {
    onRescheduleIdle: () => tricks.scheduleIdleFidgets(),
    onRescheduleSleepy: (active) => tricks.scheduleYawns(active),
    showBubble: (text, durationMs) => tricks.showBubble(text, durationMs),
  });

  // idle 小动作先跑起来（初始基态是 idle，状态机构造时不会触发 hooks）
  tricks.scheduleIdleFidgets();

  /* ---------- 点击反应：歪头 / 转圈 / 说话 + 5 连击彩蛋 ---------- */
  let combo = 0;
  let comboTimer = 0;

  function handlePetClick(): void {
    // 重置连击计时窗口
    window.clearTimeout(comboTimer);
    comboTimer = window.setTimeout(() => {
      combo = 0;
    }, COMBO_WINDOW_MS);

    combo += 1;
    if (combo >= COMBO_FOR_PARTY) {
      // 彩蛋：派对帽！
      combo = 0;
      window.clearTimeout(comboTimer);
      tricks.playAction("party");
      tricks.showBubble(pick(PARTY_QUOTES), 5000);
      return;
    }

    // 常规反应：歪头 / 转圈 / 说话 三选一（说话时配歪头，更生动）
    const roll = Math.random();
    if (roll < 0.4) {
      tricks.playAction("tilt");
    } else if (roll < 0.6) {
      tricks.playAction("spin");
    } else {
      tricks.playAction("tilt");
      tricks.showBubble(pick(CLICK_QUOTES));
    }
  }

  function handleDoubleClick(): void {
    // 双击回托盘：气泡先收掉，再隐藏窗口
    dom.bubble.classList.remove("show");
    try {
      getCurrentWindow()
        .hide()
        .catch((err) => console.warn("[pet] 隐藏窗口失败:", err));
    } catch (err) {
      // 无 Tauri 窗口环境（如纯浏览器调试）：getCurrentWindow 同步抛错，吞掉即可
      console.warn("[pet] 当前环境无窗口句柄，忽略双击隐藏:", err);
    }
  }

  /* ---------- 异步模块：事件桥 + 交互层，失败各自降级 ---------- */
  bindEvents(sm, tricks).catch((err) => {
    // 事件桥挂了：桌宠仍能展示与点击，只是收不到提醒
    console.warn("[pet] 事件绑定失败，桌宠将以纯观赏模式运行:", err);
  });

  setupPointer(dom, { onClick: handlePetClick, onDoubleClick: handleDoubleClick }).catch((err) => {
    // 交互层挂了（极端情况，如非 Tauri 环境）：挂最简单的原生 click/dblclick 兜底，
    // 至少保留点击反应、彩蛋与双击隐藏，不会变成点不动的白板
    console.warn("[pet] 交互层初始化失败，改用原生点击兜底:", err);
    dom.hit.addEventListener("click", handlePetClick);
    dom.hit.addEventListener("dblclick", handleDoubleClick);
  });

  // 页面卸载时清理（透明窗口常驻，一般走不到，聊胜于无）
  window.addEventListener("pagehide", () => tricks.dispose(), { once: true });
}

main();
