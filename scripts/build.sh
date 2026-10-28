#!/usr/bin/env bash
# Perchly 一键打包脚本
# 用法: ./scripts/build.sh     → 前端构建 + Rust release + NSIS 安装包
#       ./scripts/build.sh dev    → 仅开发模式 (npm run tauri dev)
#       ./scripts/build.sh check  → 快速自检 (tsc + cargo test)
#       ./scripts/build.sh clean  → 清理构建产物
# Windows 资源管理器可直接双击 scripts\build.cmd 调用本脚本
#
# 踩坑备注见 docs/DEVLOG.md：
#   #4 CARGO_BUILD_JOBS=2 防并行竞态；#7 NSIS 走镜像；#9 杀实例等 3 秒再打包
set -euo pipefail
cd "$(dirname "$0")"

MIRROR="https://ghfast.top"          # GitHub 镜像（NSIS 工具链下载用）
PKG_NAME="Perchly_0.1.0_x64-setup.exe"
BUNDLE_DIR="src-tauri/target/release/bundle/nsis"

log()  { printf '\033[1;36m[打包]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[完成]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[失败]\033[0m %s\n' "$*" >&2; exit 1; }

# 运行中的实例会让打包后的 exe 无法覆盖安装 → 先杀干净（含 WebView2 残留，见 DEVLOG #5/#9）
kill_instances() {
  log "清理运行中的 Perchly 实例…"
  powershell -NoProfile -NonInteractive -Command "
    Get-Process perchly -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue;
    Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" |
      Where-Object { \$_.CommandLine -match 'perchly' } |
      ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }
  " >/dev/null 2>&1 || true
  sleep 3   # WebView2 user-data-dir 锁释放
}

case "${1:-build}" in
  dev)
    exec npm run tauri dev ;;
  check)
    log "TS 类型检查…";        npx tsc --noEmit
    log "Rust 测试…";          (cd src-tauri && CARGO_BUILD_JOBS=2 cargo test --quiet)
    ok "自检通过" ;;
  clean)
    log "清理 dist 与 target…"
    rm -rf dist src-tauri/target
    ok "已清理" ;;
  build|"")
    kill_instances
    log "前端依赖…";    [ -d node_modules ] || npm install
    log "打包（release + NSIS）…"
    TAURI_BUNDLER_TOOLS_GITHUB_MIRROR="$MIRROR" npm run tauri build -- --bundles nsis
    [ -f "$BUNDLE_DIR/$PKG_NAME" ] || die "未找到产物 $BUNDLE_DIR/$PKG_NAME"
    SIZE=$(du -m "$BUNDLE_DIR/$PKG_NAME" | cut -f1)
    ok "安装包: $(cd "$BUNDLE_DIR" && pwd -W 2>/dev/null || pwd)\\$PKG_NAME ($SIZE MB)" ;;
  *)
    die "未知命令: $1（可用: build | dev | check | clean）" ;;
esac
