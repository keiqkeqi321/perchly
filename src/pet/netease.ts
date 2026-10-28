/**
 * 网易云桌宠动画资源兼容渲染器
 *
 * 资源特征（docs/NETEASE_PET_REVERSE.md）：
 * - WebM(VP9) 无 Alpha，背景为纯色但每条不同（39灰~255白都有）
 * - 正方形，~4s/动作循环，多分辨率档（640/960/1080/1440）
 *
 * 兼容策略：视频第 1 帧四角取样 → 求背景色 → shader 抠像（色距容差）
 * 渲染到透明 canvas，视频元素本身不可见（纯解码器角色）。
 */

export interface NeteaseCompatOptions {
  /** 抠像容差（0~1，越大抠得越狠）。视频压缩会带来色噪，默认 0.12 */
  tolerance?: number;
  /** 边缘软化宽度（0~1） */
  edgeSoftness?: number;
  /** 是否启用 WebGL 色距抠像。false=直显模式（视频本体 + 圆角遮罩）。
   *  网易深灰背景视频（bg luma≈39）的眼珠与背景色距过近，抠像必掉眼睛 → 默认 false */
  keying?: boolean;
}

/** 边缘采样点定义见 sampleBackgroundColor 内的 pts8 */

/** 取视频帧边缘颜色，返回背景色；离散度过大返回 null（非纯背景型资源）。
 *  多帧尝试（0.1s/1s/中段/末段）× 8 采样点（四角+边中点），取最聚集的 4 点。 */
async function sampleBackgroundColor(video: HTMLVideoElement): Promise<[number, number, number] | null> {
  const pts8: Array<[number, number]> = [
    [0.03, 0.03], [0.5, 0.03], [0.97, 0.03],
    [0.03, 0.5], [0.97, 0.5],
    [0.03, 0.97], [0.5, 0.97], [0.97, 0.97],
  ];
  const tryFrame = (t: number): Promise<[number, number, number] | null> =>
    new Promise((resolve) => {
      const cvs = document.createElement("canvas");
      cvs.width = 64; cvs.height = 64;
      const ctx = cvs.getContext("2d", { willReadFrequently: true })!;
      const grab = () => {
        try {
          ctx.drawImage(video, 0, 0, 64, 64);
          const samples = pts8
            .map(([x, y]) => Array.from(ctx.getImageData(Math.round(x * 63), Math.round(y * 63), 1, 1).data))
            .filter((d) => d[3] >= 250);
          if (samples.length < 4) { resolve(null); return; }
          // 滑窗找最聚集的连续 4 点（抗主体入侵到边缘）
          let bestSpread = Infinity, bestSet = samples.slice(0, 4);
          for (let i = 0; i + 4 <= samples.length; i++) {
            const set = samples.slice(i, i + 4);
            let spread = 0;
            for (const a of set) for (const b of set) {
              spread = Math.max(spread, Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2]));
            }
            if (spread < bestSpread) { bestSpread = spread; bestSet = set; }
          }
          if (bestSpread > 60) { resolve(null); return; }
          resolve([
            Math.round(bestSet.reduce((s, p) => s + p[0], 0) / 4),
            Math.round(bestSet.reduce((s, p) => s + p[1], 0) / 4),
            Math.round(bestSet.reduce((s, p) => s + p[2], 0) / 4),
          ]);
        } catch { resolve(null); }
      };
      const onSeeked = () => { video.removeEventListener("seeked", onSeeked); requestAnimationFrame(grab); };
      video.addEventListener("seeked", onSeeked);
      try { video.currentTime = t; } catch { grab(); }
    });

  const dur = Number.isFinite(video.duration) ? video.duration : 4;
  for (const t of [0.1, 1, dur / 2, dur - 0.5]) {
    const bg = await tryFrame(Math.max(0, t));
    if (bg) return bg;
  }
  return null;
}

/** WebGL 抠像着色器：bg 色距 < tolerance → alpha=0 */
const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec3 uBg;
uniform float uTol;      // 容差（色距域）
uniform float uSoft;     // 软化带
uniform float uDarkFloor; // 暗色下限：亮度低于此值绝不抠（保护眼珠/嘴等深色主体）
void main() {
  vec4 c = texture2D(uTex, vUV);
  float d = distance(c.rgb, uBg);
  float a = smoothstep(uTol, uTol + uSoft, d);
  // 亮度保护：背景若是亮色，暗色主体（眼/喙/阴影）保持不透明
  float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  float protect = smoothstep(uDarkFloor, uDarkFloor + 0.12, luma);
  a = max(a, protect);
  gl_FragColor = vec4(c.rgb, a);
}`;

export class NeteasePetPlayer {
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private bg: [number, number, number] | null = null;
  private running = false;
  private readonly tol: number;
  private readonly soft: number;
  /** 抠像是否启用（false = 直显模式） */
  readonly keyingEnabled: boolean;

  /** @param src WebM URL；@param opts 模式与抠像参数 */
  constructor(src: string, opts: NeteaseCompatOptions = {}) {
    this.tol = (opts.tolerance ?? 0.12) * 1.732; // rgb 距离域换算
    this.soft = (opts.edgeSoftness ?? 0.06) * 1.732;
    this.keyingEnabled = opts.keying ?? false;
    this.video = document.createElement("video");
    Object.assign(this.video, {
      src, loop: true, muted: true, playsInline: true,
      crossOrigin: "anonymous",
      preload: "auto",
    });
  }

  /** 挂载并就绪（返回是否成功；失败 false 走降级） */
  async attach(container: HTMLElement): Promise<boolean> {
    container.appendChild(this.video);
    await new Promise<void>((res) => {
      if (this.video.readyState >= 2) return res();
      this.video.addEventListener("loadeddata", () => res(), { once: true });
      this.video.addEventListener("error", () => res(), { once: true });
    });
    if (!this.video.videoWidth) return false; // 加载失败

    if (!this.keyingEnabled) {
      // 直显模式：视频本体可见 + 圆角贴纸观感（与网易云官方一致）
      this.video.style.display = "";
      this.video.className = "netease-raw";
      this.play();
      return true;
    }

    // 抠像模式：取样背景 → WebGL 渲染
    this.bg = await sampleBackgroundColor(this.video);
    if (!this.bg) return false; // 背景不纯，无法抠像
    this.setupGL(container);
    if (!this.gl) return false;
    this.play();
    return true;
  }

  private setupGL(container: HTMLElement) {
    const canvas = document.createElement("canvas");
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    container.appendChild(canvas);
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
    if (!gl) return;
    this.gl = gl;

    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog); gl.useProgram(prog);
    this.prog = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    gl.uniform3f(gl.getUniformLocation(prog, "uBg"), this.bg![0]/255, this.bg![1]/255, this.bg![2]/255);
    gl.uniform1f(gl.getUniformLocation(prog, "uTol"), this.tol);
    gl.uniform1f(gl.getUniformLocation(prog, "uSoft"), this.soft);
    // 暗色保护：背景亮度 - 0.18（暗背景则不启用保护，避免背景残留）
    const bgLuma = (this.bg![0]*0.299 + this.bg![1]*0.587 + this.bg![2]*0.114) / 255;
    const darkFloor = bgLuma > 0.45 ? Math.max(0.06, bgLuma - 0.18) : 0.0;
    gl.uniform1f(gl.getUniformLocation(prog, "uDarkFloor"), darkFloor);
  }

  private renderLoop = () => {
    if (!this.running || !this.gl || !this.prog) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(this.renderLoop);
  };

  play() { this.running = true; void this.video.play(); requestAnimationFrame(this.renderLoop); }
  pause() { this.running = false; this.video.pause(); }

  /** 视频时长 ms（轮播调度用） */
  get durationMs(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration * 1000 : 4000;
  }

  destroy() {
    this.pause();
    this.video.remove(); this.canvas?.remove();
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
