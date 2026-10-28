/**
 * pet.html 入口：组装桌宠。
 *
 * 职责拆分：
 *   dom.ts     静态骨架引用
 *   state.ts   基态状态机（is-xxx）
 *   tricks.ts  瞬时动作 + 气泡（act-xxx）
 *   bridge.ts  后端事件 → 状态翻译
 *   pointer.ts 拖拽 / 点击 / 右键菜单 / 鼠标穿透
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

  /* ---------- 宠物包资源模式 + 皮肤热切换 ----------
   * 设置来源（优先级）：
   *   1. URL 参数 ?pack=<id>（调试用，覆盖设置）
   *   2. 设置项 petSkin（托盘/设置页切换，事件 pet-skin-changed 热切换）
   * 皮肤值：svg=自绘鹦鹉；pack=宠物包视频直显（圆角贴纸）
   */
  const params = new URLSearchParams(location.search);
  const urlSkin = params.get("pack");
  if (urlSkin) {
    // 调试参数：?pack=1 强制宠物包皮肤
    void applySkin("pack");
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

  /* ---------- 异步模块：事件桥 + 交互层，失败各自降级 ---------- */
  bindEvents(sm, tricks).catch((err) => {
    // 事件桥挂了：桌宠仍能展示与点击，只是收不到提醒
    console.warn("[pet] 事件绑定失败，桌宠将以纯观赏模式运行:", err);
  });

  setupPointer(dom, {
    onClick: handlePetClick,
    // 右键 → Rust 在光标处弹与托盘一致的菜单（显隐项文案随可见性翻转）
    onContextMenu: () => {
      void invoke("popup_pet_menu").catch((err) => console.warn("[pet] 右键菜单弹出失败:", err));
    },
    onDragStart: () => { void packEngine?.dragStart(); },
    onDragEnd: () => packEngine?.dragEnd(),
  }).catch((err) => {
    // 交互层挂了（极端情况，如非 Tauri 环境）：挂最简单的原生事件兜底，
    // 至少保留点击反应与彩蛋，不会变成点不动的白板
    console.warn("[pet] 交互层初始化失败，改用原生点击兜底:", err);
    dom.hit.addEventListener("click", handlePetClick);
    const onContextMenu = (e: Event): void => {
      e.preventDefault();
      void invoke("popup_pet_menu").catch(() => {});
    };
    dom.hit.addEventListener("contextmenu", onContextMenu);
    dom.videoHit.addEventListener("contextmenu", onContextMenu);
  });

  // 页面卸载时清理（透明窗口常驻，一般走不到，聊胜于无）
  window.addEventListener("pagehide", () => tricks.dispose(), { once: true });
}

/* ================= 皮肤系统（applySkin 统一入口） ================= */

/** 当前皮肤（点击行为分流用） */
let currentSkin = "svg";

/** 宠物包引擎（pack 皮肤时活动） */
let packEngine: PetPackEngine | null = null;
let packStage: HTMLElement | null = null;
let applySeq = 0; // 防竞态：只允许最后一次 applySkin 生效
const DEFAULT_PACK = "cockatiel";

interface SkinOpts {
  pack?: string;
}

/** 切换桌宠皮肤。svg=自绘；pack=宠物包双层引擎。 */
async function applySkin(skin: string, opts: SkinOpts = {}): Promise<void> {
  const seq = ++applySeq;
  const dom = getPetDom();
  currentSkin = skin;

  // —— SVG 皮肤：清掉视频层，恢复 SVG ——
  if (skin === "svg") {
    disposePack(dom);
    setHitShape("ellipse");
    dom.videoHit.style.display = "none";
    dom.root.classList.remove("skin-pending");
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

    // 清旧引擎，但 SVG 保持移出（即将再进视频模式，等待期不该闪现 SVG）
    disposePack(dom, { keepSvgDetached: true });
    // 先移出 SVG 再异步启动：引擎启动要等视频首帧（数百 ms），
    // 若事后再 detach，等待期 SVG 在 DOM 里裸奔，合成器画一帧就是"闪默认 SVG"
    detachSvgLayer(dom);

    const stage = document.createElement("div");
    stage.className = "pack-stage";
    // 挂 #pet-root（与 .pet-stage 平级）：脱离 .pet-inner 形变容器——
    // SVG 状态机的 act-tilt/跳跃等 transform 作用于 .pet-inner，视频在里面会被带着形变
    dom.root.appendChild(stage);

    const engine = new PetPackEngine(pack, stage);
    const ok = await engine.start();
    if (seq !== applySeq) { engine.dispose(); stage.remove(); return; }
    if (!ok) throw new Error("引擎启动失败");

    packEngine = engine;
    packStage = stage;

    // 视频模式接管：Zzz 深度隐藏（detachSvgLayer 已做），启用矩形命中层，揭面纱
    setHitShape("rect");
    dom.videoHit.style.display = "";
    dom.root.classList.remove("skin-pending");

    console.info(`[pet] 皮肤: 宠物包「${pack.name}」(${pack.id}) 待机×${pack.assets.idle.length} 交互×${pack.assets.interact.length}`);
  } catch (err) {
    if (seq === applySeq) {
      console.warn("[pet] 宠物包不可用，回退 SVG:", err);
      disposePack(dom);
      dom.root.classList.remove("skin-pending");
    }
  }
}

/** 清理宠物包引擎。keepSvgDetached=true 时 SVG 保持移出（pack→pack 重入，
 *  等待期不该露脸）；默认重挂 SVG（切回 SVG / 回退场景） */
function disposePack(
  dom: ReturnType<typeof getPetDom>,
  opts: { keepSvgDetached?: boolean } = {},
): void {
  packEngine?.dispose();
  packEngine = null;
  packStage?.remove();
  packStage = null;
  if (!opts.keepSvgDetached) reattachSvgLayer(dom);
}

/** SVG 移出 DOM + 冻结 stage 动画（视频模式）。幂等：重复调用只补冻结标记。
 *  根因①：display:none 的 SVG 仍带 CSS 动画，状态机 class 切换（act-tilt/act-blink）
 *  触发样式重算时，WebView2 合成器偶发把启动时的旧帧缓存错误上屏一帧。
 *  根因②：.pet-inner 是形变容器（歪头/跳跃 transform），视频曾挂其内被带着形变跳动。
 *  移出 DOM + 冻结动画 = 双隔离，视频与 SVG 各自独立 */
let svgHome: { parent: HTMLElement; next: Node | null } | null = null;
const detachedZzz: { el: HTMLElement; parent: HTMLElement; next: Node | null }[] = [];

function detachSvgLayer(dom: ReturnType<typeof getPetDom>): void {
  if (dom.svg.isConnected) {
    svgHome = { parent: dom.svg.parentElement!, next: dom.svg.nextSibling };
    dom.svg.remove();
    // Zzz 归位信息只在实际移出时收集（重复调用不得清空已记录的归位信息）
    detachedZzz.length = 0;
    document.querySelectorAll<HTMLElement>(".zzz").forEach((el) => {
      detachedZzz.push({ el, parent: el.parentElement!, next: el.nextSibling });
      el.remove();
    });
  }
  // 冻结 stage 全部动效（气泡除外——视频模式气泡仍要平滑显隐）
  dom.stage.classList.add("stage-frozen");
}

/** SVG 插回原位、解冻 stage（切回 SVG 皮肤） */
function reattachSvgLayer(dom: ReturnType<typeof getPetDom>): void {
  dom.stage.classList.remove("stage-frozen");
  if (svgHome && !dom.svg.isConnected) {
    const next = svgHome.next?.isConnected ? svgHome.next : null;
    svgHome.parent.insertBefore(dom.svg, next);
    svgHome = null;
  }
  dom.svg.style.display = "";
  for (const { el, parent, next } of detachedZzz) {
    if (!el.isConnected) {
      const anchor = next?.isConnected ? next : null;
      parent.insertBefore(el, anchor);
    }
    el.style.display = "";
  }
  detachedZzz.length = 0;
}

main();
