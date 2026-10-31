/**
 * 桌宠视频动画播放器（Windows WebM / macOS HEVC Alpha）
 *
 * 资源特征：
 * - WebM(VP9) 和对应的 HEVC 视频均带 Alpha 透明通道
 * - 正方形，~4s/动作循环，多分辨率档（640/960/1080/1440）
 *
 * 呈现策略：直接播放视频，通过 Alpha 通道合成透明背景。
 */

/** 等首帧上屏的兜底超时：内存吃紧时解码器可能长时间不给帧，
 *  不能让挂起方（引擎启动/换片）永远等下去——超时先放行 */
const FIRST_FRAME_TIMEOUT_MS = 2000;

export class PetVideoPlayer {
  private video: HTMLVideoElement;

  /** @param src 视频 URL */
  constructor(src: string) {
    this.video = document.createElement("video");
    Object.assign(this.video, {
      src, loop: true, muted: true, playsInline: true,
      crossOrigin: "anonymous",
      preload: "auto",
    });
    this.video.className = "pack-video";
  }

  /** 挂载并就绪。waitForFrame=true 时等到第一帧真正可呈现才 resolve（防换片空白闪烁） */
  async attach(container: HTMLElement, opts: { waitForFrame?: boolean } = {}): Promise<boolean> {
    container.appendChild(this.video);
    await new Promise<void>((res) => {
      if (this.video.readyState >= 2) return res();
      this.video.addEventListener("loadeddata", () => res(), { once: true });
      this.video.addEventListener("error", () => res(), { once: true });
    });
    if (!this.video.videoWidth) return false; // 加载失败
    this.play();
    if (opts.waitForFrame && "requestVideoFrameCallback" in this.video) {
      // 等第一帧解码上屏（对旧浏览器/WebView 降级为立即返回）；
      // 与超时竞速：帧不来就放行，宁可稍后补帧也不能挂死换片流程
      await new Promise<void>((res) => {
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          res();
        };
        const timer = window.setTimeout(done, FIRST_FRAME_TIMEOUT_MS);
        (this.video as HTMLVideoElement & { requestVideoFrameCallback(cb: () => void): number })
          .requestVideoFrameCallback(() => done());
      });
    }
    return true;
  }

  /** 临时隐藏（预加载新片时用，保持解码不动布局） */
  setHidden(hidden: boolean): void {
    this.video.style.visibility = hidden ? "hidden" : "";
  }

  play() { void this.video.play(); }
  pause() { this.video.pause(); }

  /** 视频时长 ms（轮播调度用） */
  get durationMs(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration * 1000 : 4000;
  }

  destroy() {
    this.pause();
    this.video.remove();
  }
}
