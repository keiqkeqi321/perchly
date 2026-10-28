#!/usr/bin/env python3
"""网易云桌宠资源导入工具（Python 版，bash 版 ffprobe 启动过慢已弃用）
用法: python scripts/import_netease.py [源目录] [目标目录]
  源目录默认: %LOCALAPPDATA%/Netease/CloudMusic/Statics
  目标目录默认: public/assets/pets/netease
识别 .dat 中实为 WebM(VP9, 魔数 1A45DFA3) 的文件 → 复制改名 .webm → 生成 manifest.json
"""
import os, sys, json, shutil, subprocess

SRC_DEFAULT = os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Netease\CloudMusic\Statics")
FFPROBE_DEFAULT = os.path.join(os.environ.get("LOCALAPPDATA", ""),
    r"Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1-full_build\bin\ffprobe.exe")

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else SRC_DEFAULT
    dst = sys.argv[2] if len(sys.argv) > 2 else "public/assets/pets/netease"
    ffprobe = os.environ.get("FFPROBE", FFPROBE_DEFAULT)
    if not os.path.isdir(src):
        sys.exit(f"[失败] 源目录不存在: {src}")
    os.makedirs(dst, exist_ok=True)

    items = []
    for f in os.listdir(src):
        if not f.endswith(".dat"):
            continue
        p = os.path.join(src, f)
        with open(p, "rb") as fh:
            if fh.read(4) != b"\x1a\x45\xdf\xa3":
                continue
        base = f[:-4]
        r = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height", "-of", "csv=p=0", p],
                           capture_output=True, text=True)
        try:
            w, h = r.stdout.strip().split(",")
            w, h = int(w), int(h)
        except ValueError:
            w = h = 0
        shutil.copy(p, os.path.join(dst, base + ".webm"))
        items.append({"id": base, "file": base + ".webm", "width": w, "height": h})
        print(f"  + {base}.webm  {w}x{h}")

    with open(os.path.join(dst, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(items, fh, ensure_ascii=False, indent=1)
    print(f"[完成] 导入 {len(items)} 个 → {dst}/manifest.json")

if __name__ == "__main__":
    main()
