#!/bin/bash
# 带 stderr 日志启动 E听说（排查渲染进程崩溃用）
# 双击即可。日志写到 ~/Library/Application Support/E听说/logs/stderr.log
cd "$(dirname "$0")" || exit 1
APP="./dist/E听说.app/Contents/MacOS/E听说"
LOG="$HOME/Library/Application Support/E听说/logs/stderr.log"
mkdir -p "$(dirname "$LOG")"
echo "===== $(date '+%Y-%m-%d %H:%M:%S') 启动 =====" >> "$LOG"
pkill -f "E听说.app/Contents/MacOS" 2>/dev/null
sleep 1
env -u ELECTRON_RUN_AS_NODE "$APP" >> "$LOG" 2>&1
echo "===== $(date '+%Y-%m-%d %H:%M:%S') 退出 =====" >> "$LOG"
