#!/bin/bash
set -euo pipefail
OUT="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${1:?Output pkg path required}")"
cd "$(dirname "$0")"
BUILD="${RINGHI_BUILD_DIR:-/private/tmp/ringhi-native-macos-build.noindex}"
APP="$BUILD/RingHi Flasher.app"
ROOT="$BUILD/package-root"
SCRIPTS="$BUILD/package-scripts"
mkdir -p "$ROOT/Applications" "$SCRIPTS" "$(dirname "$OUT")"
ditto --norsrc "$APP" "$ROOT/Applications/RingHi Flasher.app"
python3 - "$BUILD/components.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1],'wb') as f:
 plistlib.dump([dict(BundleHasStrictIdentifier=True,BundleIsRelocatable=False,BundleIsVersionChecked=True,BundleOverwriteAction='upgrade',RootRelativeBundlePath='Applications/RingHi Flasher.app')],f)
PY
cat > "$SCRIPTS/preinstall" <<'PRE'
#!/bin/sh
if /usr/bin/pgrep -f '^/Applications/RingHi Flasher.app/Contents/MacOS/RingHi Flasher' >/dev/null; then
 echo '请退出 RingHi 后再次安装；正在执行的任务不会被安装器强制终止。' >&2
 exit 1
fi
exit 0
PRE
chmod 755 "$SCRIPTS/preinstall"
pkgbuild --root "$ROOT" --component-plist "$BUILD/components.plist" --scripts "$SCRIPTS" --identifier com.aispea.ringhi.flasher.native.pkg --version 0.4.5 --install-location / "$OUT"
