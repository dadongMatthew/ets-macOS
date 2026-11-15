#!/bin/bash
# 打包成 macOS dmg（内含 E听说.app + 应用程序快捷方式，拖进去即可安装）
# 用法: ./build-dmg.sh [输出目录，默认 ./dist]
set -euo pipefail

cd "$(dirname "$0")"
OUT_DIR="${1:-$PWD/dist}"
APP_NAME="E听说"
VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
DMG="$OUT_DIR/${APP_NAME}-${VERSION}.dmg"

# ---------- 1. 先打 .app ----------
./build.sh "$OUT_DIR"

APP_PATH="$OUT_DIR/$APP_NAME.app"
[ -d "$APP_PATH" ] || { echo "❌ 没找到 $APP_PATH"; exit 1; }

# ---------- 2. 组装 dmg 内容 ----------
STAGE="$(mktemp -d)/dmg"
mkdir -p "$STAGE"
# ditto 保留资源分支/权限；cp -R 对 .app 偶发丢 xattr
ditto "$APP_PATH" "$STAGE/$APP_NAME.app"
ln -s /Applications "$STAGE/应用程序"

# 让 Finder 里看到的窗口干净一点（不显示 .DS_Store 之类的隐藏项）
chflags hidden "$STAGE/.background" 2>/dev/null || true

# ---------- 3. 生成 dmg（压缩只读） ----------
rm -f "$DMG"
hdiutil detach "/Volumes/$APP_NAME" -force >/dev/null 2>&1 || true
echo "生成 $DMG …"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGE" \
  -fs HFS+ \
  -format UDZO \
  -ov \
  "$DMG" >/dev/null

# ---------- 4. 校验 ----------
hdiutil verify "$DMG" >/dev/null && echo "dmg 校验通过"
SIZE=$(du -sh "$DMG" | awk '{print $1}')

rm -rf "$(dirname "$STAGE")"

echo ""
echo "✅ 打包完成: $DMG ($SIZE)"
echo "   安装方式：双击打开 dmg，把 ${APP_NAME} 拖到「应用程序」文件夹"
