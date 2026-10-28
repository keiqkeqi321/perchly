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
import { NeteasePetPlayer } from "./pet/netease";

/** 连击彩蛋：连续点击次数（超时窗口内） */
const COMBO_FOR_PARTY = 5;
/** 连击超时窗口：超过该间隔未点击则清零 */
const COMBO_WINDOW_MS = 2500;

function main(): void {
  const dom = getPetDom();

  /* ---------- 网易云资源兼容模式 ----------
   * URL: /pet.html?netease=<id|random|all>[&key=1]
   *   - <id>：播放 manifest 中指定资源
   *   - random：随机一条
   *   - all：顺序轮播（每条循环三遍后切换）
   *   - &key=1：启用 WebGL 色距抠像（深灰背景视频会误抠眼睛，默认关闭）
   * 默认直显模式：视频本体 + 圆角遮罩（与网易云官方呈现一致的贴纸观感）
   * 失败自动回退 SVG 状态机。
   */
  const neteaseParam = new URLSearchParams(location.search).get("netease");
  if (neteaseParam) {
    void tryNeteaseMode(dom, neteaseParam);
  }

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

  /* ---------- 点击反应：歪头 / 说话 + 5 连击彩蛋 ---------- */
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

    // 常规反应：歪头 / 说话二选一（原转圈 spin 属根节点旋转动画，已移除）
    if (Math.random() < 0.4) {
      tricks.playAction("tilt");
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

/** 网易云资源兼容模式实现：加载 manifest → 选资源 → 直显/抠像 → 隐藏 SVG */
async function tryNeteaseMode(dom: ReturnType<typeof getPetDom>, param: string): Promise<void> {
  interface ManifestItem { id: string; file: string; width: number; height: number }
  try {
    const res = await fetch("/assets/pets/netease/manifest.json");
    const items: ManifestItem[] = await res.json();
    if (!items.length) return;

    // 选资源：random 随机 / all 轮播（此处取随机起点）/ 指定 id
    let item: ManifestItem;
    if (param === "random" || param === "all") {
      item = items[Math.floor(Math.random() * items.length)];
    } else {
      item = items.find((it) => it.id === param) ?? items[0];
    }

    const stage = document.createElement("div");
    stage.className = "netease-stage";
    dom.inner.appendChild(stage);

    const player = new NeteasePetPlayer(`/assets/pets/netease/${item.file}`, {
      // &key=1 才抠像；深灰背景视频抠像会误伤眼珠，默认直显
      keying: new URLSearchParams(location.search).get("key") === "1",
    });
    const ok = await player.attach(stage);
    if (!ok) {
      console.warn("[pet] 网易资源初始化失败，回退 SVG 模式");
      stage.remove();
      return;
    }

    // 成功：隐藏 SVG 鹦鹉与 Zzz，视频模式接管
    dom.svg.style.display = "none";
    document.querySelectorAll(".zzz").forEach((el) => ((el as HTMLElement).style.display = "none"));

    // all 模式：每条播放三遍后换下一条
    if (param === "all") {
      const idx = items.indexOf(item);
      window.setTimeout(() => {
        player.destroy(); stage.remove();
        dom.svg.style.display = "";
        void tryNeteaseMode(dom, items[(idx + 1) % items.length].id);
      }, (player.durationMs || 4000) * 3);
    }

    console.info(`[pet] 网易云模式${player.keyingEnabled ? "(抠像)" : "(直显)"}: ${item.id} (${item.width}x${item.height})`);
  } catch (err) {
    console.warn("[pet] 网易云模式初始化失败，回退 SVG:", err);
  }
}

main();
