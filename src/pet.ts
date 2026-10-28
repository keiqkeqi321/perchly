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
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { CLICK_QUOTES, PARTY_QUOTES, pick } from "./pet/quotes";
import { PetPackEngine, type PetPack } from "./pet/petpack";
import { setHitShape } from "./pet/pointer";

/** 连击彩蛋：连续点击次数（超时窗口内） */
const COMBO_FOR_PARTY = 5;
/** 连击超时窗口：超过该间隔未点击则清零 */
const COMBO_WINDOW_MS = 2500;

function main(): void {
  const dom = getPetDom();

  /* ---------- 网易云资源兼容模式 + 皮肤热切换 ----------
   * 设置来源（优先级）：
   *   1. URL 参数 ?netease=<id|random|all>（调试用，覆盖设置）
   *   2. 设置项 petSkin（托盘/设置页切换，事件 pet-skin-changed 热切换）
   * 皮肤值：svg=自绘鹦鹉；netease=网易云直显（圆角贴纸）
   */
  const params = new URLSearchParams(location.search);
  const urlSkin = params.get("netease");
  if (urlSkin) {
    // 调试参数：?netease=1 强制宠物包皮肤（不支持单条指定，改用 triggerRules）
    void applySkin("netease");
  } else {
    // 初始皮肤：读设置，失败走 SVG
    void invoke<{ petSkin?: string }>("get_settings")
      .then((s) => applySkin(s.petSkin ?? "svg"))
      .catch(() => applySkin("svg"));

    // 托盘/设置页切换 → 热切换
    listen<string>("pet-skin-changed", (ev) => {
      void applySkin(ev.payload);
    }).catch(() => {});
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
    // 视频皮肤：点击 = 随机交互动作（背景/台词按 triggerRules 绑定）
    if (currentSkin !== "svg" && packEngine) {
      window.clearTimeout(comboTimer);
      comboTimer = window.setTimeout(() => { combo = 0; }, COMBO_WINDOW_MS);
      combo += 1;
      if (combo >= COMBO_FOR_PARTY) {
        combo = 0;
        window.clearTimeout(comboTimer);
        tricks.showBubble(pick(PARTY_QUOTES), 5000);
        void packEngine.interact().then((q) => { if (q.length) tricks.showBubble(pick(q)); });
        return;
      }
      void packEngine.interact().then((q) => {
        tricks.showBubble(q.length ? pick(q) : pick(CLICK_QUOTES));
      });
      return;
    }

    // SVG 皮肤：原点击反应
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

  setupPointer(dom, {
    onClick: handlePetClick,
    onDoubleClick: handleDoubleClick,
    onDragStart: () => { void packEngine?.dragStart(); },
    onDragEnd: () => packEngine?.dragEnd(),
  }).catch((err) => {
    // 交互层挂了（极端情况，如非 Tauri 环境）：挂最简单的原生 click/dblclick 兜底，
    // 至少保留点击反应、彩蛋与双击隐藏，不会变成点不动的白板
    console.warn("[pet] 交互层初始化失败，改用原生点击兜底:", err);
    dom.hit.addEventListener("click", handlePetClick);
    dom.hit.addEventListener("dblclick", handleDoubleClick);
  });

  // 页面卸载时清理（透明窗口常驻，一般走不到，聊胜于无）
  window.addEventListener("pagehide", () => tricks.dispose(), { once: true });
}

/* ================= 皮肤系统（applySkin 统一入口） ================= */

/** 当前皮肤（点击行为分流用） */
let currentSkin = "svg";

/** 宠物包引擎（netease 皮肤时活动） */
let packEngine: PetPackEngine | null = null;
let packStage: HTMLElement | null = null;
let applySeq = 0; // 防竞态：只允许最后一次 applySkin 生效
const DEFAULT_PACK = "netease-cockatiel";

interface SkinOpts {
  pack?: string;
}

/** 切换桌宠皮肤。svg=自绘；netease=宠物包双层引擎。 */
async function applySkin(skin: string, opts: SkinOpts = {}): Promise<void> {
  const seq = ++applySeq;
  const dom = getPetDom();
  currentSkin = skin;

  // —— SVG 皮肤：清掉视频层，恢复 SVG ——
  if (skin === "svg") {
    disposePack(dom);
    setHitShape("ellipse");
    dom.videoHit.style.display = "none";
    console.info("[pet] 皮肤: SVG 鹦鹉");
    return;
  }

  // —— 宠物包皮肤：读 manifest → 建双层引擎 ——
  const packId = opts.pack ?? DEFAULT_PACK;
  try {
    const res = await fetch(`/assets/pets/${packId}/manifest.json`);
    const pack: PetPack = await res.json();
    if (seq !== applySeq) return;
    if (!pack.assets.idle.length) throw new Error("宠物包没有待机动画");

    disposePack(dom); // 清旧层

    const stage = document.createElement("div");
    stage.className = "netease-stage";
    dom.inner.appendChild(stage);

    const engine = new PetPackEngine(pack, stage);
    const ok = await engine.start();
    if (seq !== applySeq) { engine.dispose(); stage.remove(); return; }
    if (!ok) throw new Error("引擎启动失败");

    packEngine = engine;
    packStage = stage;

    // 视频模式接管：隐藏 SVG 与 Zzz，启用矩形命中层
    dom.svg.style.display = "none";
    document.querySelectorAll(".zzz").forEach((el) => ((el as HTMLElement).style.display = "none"));
    setHitShape("rect");
    dom.videoHit.style.display = "";

    console.info(`[pet] 皮肤: 宠物包「${pack.name}」(${pack.id}) 待机×${pack.assets.idle.length} 交互×${pack.assets.interact.length}`);
  } catch (err) {
    if (seq === applySeq) {
      console.warn("[pet] 宠物包不可用，回退 SVG:", err);
      disposePack(dom);
    }
  }
}

/** 清理宠物包引擎并恢复 SVG 可见 */
function disposePack(dom: ReturnType<typeof getPetDom>): void {
  packEngine?.dispose();
  packEngine = null;
  packStage?.remove();
  packStage = null;
  dom.svg.style.display = "";
  document.querySelectorAll(".zzz").forEach((el) => ((el as HTMLElement).style.display = ""));
}

main();
