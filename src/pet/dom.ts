/**
 * 一次性收集桌宠需要的 DOM 引用（pet.html 中的静态骨架）。
 *
 * SVG 鹦鹉不在此处收集：它收在 <template id="pet-svg-tpl"> 里惰性挂载
 * （mountSvg/unmountSvg）。pack（宠物包）模式下 SVG 节点完全不存在，
 * 合成器拿不到任何 SVG 纹理——这是"视频模式偶现闪 SVG"的根治手段。
 */

export interface PetDom {
  /** 最外层全窗口容器（视频层挂这里，脱离 .pet-inner 形变容器） */
  root: HTMLElement;
  /** 状态 class（is-xxx / act-xxx）挂载点 */
  stage: HTMLElement;
  /** 说话气泡容器 */
  bubble: HTMLElement;
  /** 气泡文字 */
  bubbleText: HTMLElement;
  /** 视频模式矩形命中层（220x220 全窗口，宠物包皮肤时显示） */
  videoHit: HTMLElement;
  /** SVG 所在的内层容器（形变容器：歪头/跳跃 transform 作用于此） */
  inner: HTMLElement;
  /** 挂载 SVG 鹦鹉（幂等）：克隆模板进 .pet-inner，返回实例；模板缺失返回 null */
  mountSvg(): SVGSVGElement | null;
  /** 彻底移除 SVG 鹦鹉（幂等）：节点销毁而非隐藏——pack 模式零绘制 */
  unmountSvg(): void;
}

/** 查找必需元素，找不到直接抛错（骨架写错时尽早暴露） */
function required<T extends Element>(selector: string): T {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`[pet] 缺少必需元素: ${selector}`);
  return el as T;
}

/** 当前挂载的 SVG 实例（未挂载为 null；pack 模式不持有任何 SVG 节点） */
let svgInstance: SVGSVGElement | null = null;

/** 克隆模板挂载 SVG 鹦鹉（幂等） */
function mountSvg(inner: HTMLElement): SVGSVGElement | null {
  if (svgInstance?.isConnected) return svgInstance;
  const tpl = document.querySelector<HTMLTemplateElement>("#pet-svg-tpl");
  const svg = tpl?.content.querySelector("svg")?.cloneNode(true) ?? null;
  if (!(svg instanceof SVGSVGElement)) return null;
  inner.appendChild(svg);
  svgInstance = svg;
  return svg;
}

/** 彻底移除 SVG 鹦鹉（幂等）：连实例引用一起丢弃，下次挂载重新克隆 */
function unmountSvg(): void {
  svgInstance?.remove();
  svgInstance = null;
}

export function getPetDom(): PetDom {
  const inner = required<HTMLElement>(".pet-inner");
  return {
    root: required<HTMLElement>("#pet-root"),
    stage: required<HTMLElement>("#pet-stage"),
    bubble: required<HTMLElement>("#pet-bubble"),
    bubbleText: required<HTMLElement>("#pet-bubble-text"),
    videoHit: ensureVideoHit(),
    inner,
    mountSvg: () => mountSvg(inner),
    unmountSvg,
  };
}

/** 视频命中层：动态创建（老骨架无需改 pet.html），仅创建时初始隐藏 */
function ensureVideoHit(): HTMLElement {
  let el = document.querySelector<HTMLElement>("#pet-video-hit");
  if (!el) {
    el = document.createElement("div");
    el.id = "pet-video-hit";
    el.style.display = "none";
    document.body.appendChild(el);
  }
  return el;
}
