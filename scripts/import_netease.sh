#!/usr/bin/env bash
# 网易云桌宠资源导入工具（wrapper）—— 实际逻辑见 import_netease.py
# bash 直连 ffprobe 启动过慢，已改 Python 实现
set -euo pipefail
cd "$(dirname "$0")/.."
exec python scripts/import_netease.py "$@"
