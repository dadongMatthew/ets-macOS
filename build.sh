#!/bin/bash
# 打包成 macOS .app（不需要 Xcode，只用系统自带工具）
# 用法: ./build.sh [输出目录，默认 ./dist]
set -euo pipefail

cd "$(dirname "$0")"
OUT_DIR="${1:-$PWD/dist}"
APP_NAME="E听说"
BUNDLE_ID="com.ets100.mac.shell"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"

# ---------- 1. 找到 Electron 运行时 ----------
ELECTRON_APP=""
for p in \
  "node_modules/electron/dist/Electron.app" \
  "/tmp/el3/Electron.app" \
  "/tmp/el2/Electron.app" ; do
  if [ -d "$p" ]; then ELECTRON_APP="$p"; break; fi
done

if [ -z "$ELECTRON_APP" ]; then
  echo "未找到 Electron.app，尝试从缓存/镜像恢复…"
  ZIP=$(find "$HOME/Library/Caches/electron" -name "electron-v*-darwin-*.zip" | sort | tail -1)
  if [ -z "$ZIP" ]; then
    echo "没有缓存，请先执行: npm install"
    exit 1
  fi
  mkdir -p node_modules/electron/dist
  ditto -x -k "$ZIP" node_modules/electron/dist
  ELECTRON_APP="node_modules/electron/dist/Electron.app"
fi

echo "使用运行时: $ELECTRON_APP"

# ---------- 2. 组装 .app ----------
rm -rf "$OUT_DIR/$APP_NAME.app"
mkdir -p "$OUT_DIR"
cp -R "$ELECTRON_APP" "$OUT_DIR/$APP_NAME.app"
TARGET="$OUT_DIR/$APP_NAME.app"
CONTENTS="$TARGET/Contents"

# 可执行文件改名（macOS 依据 CFBundleExecutable 启动）
mv "$CONTENTS/MacOS/Electron" "$CONTENTS/MacOS/$APP_NAME"

# 清掉 Electron 自带的默认应用
rm -rf "$CONTENTS/Resources/default_app.asar"

# ---------- 3. 放入我们的应用代码 ----------
APP_DIR="$CONTENTS/Resources/app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -R app "$APP_DIR/app"
cp -R resources "$APP_DIR/resources"
cp package.json "$APP_DIR/package.json"
# 去掉开发期依赖，打包后只保留运行必需文件
python3 - "$APP_DIR/package.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.pop('devDependencies', None)
d['main'] = 'app/main.js'
d['name'] = 'ets-mac-shell'
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
PY

# ---------- 4. Info.plist ----------
PLIST="$CONTENTS/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $APP_NAME" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleName $APP_NAME" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $APP_NAME" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$PLIST" 2>/dev/null || true
# 麦克风用途说明（口语练习录音）
/usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string 需要使用麦克风完成英语听说练习与录音" "$PLIST"
# 允许加载 http 资源（页面内仍有部分 http 链接）
/usr/libexec/PlistBuddy -c "Delete :NSAppTransportSecurity" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$PLIST"
/usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool true" "$PLIST"

# ---------- 5. 重新签名（关键：不签名会被 macOS 直接丢弃） ----------
xattr -cr "$TARGET" 2>/dev/null || true
codesign --force --deep --sign - "$TARGET" 2>&1 | tail -2
codesign -v "$TARGET" && echo "签名校验通过"

echo ""
echo "✅ 打包完成: $OUT_DIR/$APP_NAME.app"
echo "   双击打开，或: open \"$OUT_DIR/$APP_NAME.app\""
