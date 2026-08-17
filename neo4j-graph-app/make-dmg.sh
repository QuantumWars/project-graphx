#!/bin/bash
# Build a real, distributable .dmg from the packaged .app — drag-to-Applications
# layout, same pattern every normal Mac app installer uses. Uses hdiutil, which
# ships with macOS — no extra dependency beyond what electron-packager already needs.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="project-graphx"
DIST_DIR="dist/${APP_NAME}-darwin-arm64"
APP_PATH="${DIST_DIR}/${APP_NAME}.app"
DMG_OUT="dist/${APP_NAME}.dmg"
STAGING="dist/.dmg-staging"

if [ ! -d "$APP_PATH" ]; then
  echo "No packaged .app found at $APP_PATH — run 'npm run pack' first." >&2
  exit 1
fi

rm -rf "$STAGING" "$DMG_OUT"
mkdir -p "$STAGING"
cp -R "$APP_PATH" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

hdiutil create -volname "$APP_NAME" -srcfolder "$STAGING" -ov -format UDZO "$DMG_OUT"
rm -rf "$STAGING"

echo "Built: $DMG_OUT"
