#!/usr/bin/env bash
# 桌宠动画资源导入工具（wrapper）—— 实际逻辑见 import_pet_assets.py
# bash 直连 ffprobe 启动过慢，已改 Python 实现
set -euo pipefail
cd "$(dirname "$0")/.."
exec python scripts/import_pet_assets.py "$@"
