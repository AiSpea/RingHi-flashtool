#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"
BUILD="${RINGHI_BUILD_DIR:-/private/tmp/ringhi-native-macos-build.noindex}"
APP="$BUILD/RingHi Flasher.app"
mkdir -p "$BUILD" "$APP/Contents/MacOS" "$APP/Contents/Resources/Tools" "$APP/Contents/Frameworks"
SOURCE="$BUILD/libusb-1.0.30"
if [ ! -d "$SOURCE" ]; then tar -xjf Tools/libusb-1.0.30.tar.bz2 -C "$BUILD"; fi
xcrun clang -Wno-deprecated-declarations -mmacosx-version-min=13.0 -I"$SOURCE/libusb" -c Bridge/RingHiBridge.c -o "$BUILD/Bridge.o"
xcrun swiftc -swift-version 5 -O -parse-as-library -target arm64-apple-macos13.0 -module-cache-path /tmp/ringhi-swift-modules -import-objc-header Bridge/RingHiBridge.h Sources/*.swift "$BUILD/Bridge.o" -LTools -lusb-1.0.0 -framework IOKit -framework Security -framework AppKit -Xlinker -rpath -Xlinker @executable_path/../Frameworks -o "$APP/Contents/MacOS/RingHi Flasher"
cp Tools/libusb-1.0.0.dylib "$APP/Contents/Frameworks/"
cp Tools/esptool Tools/*LICENSE* Tools/*zip Tools/*bz2 "$APP/Contents/Resources/Tools/"
cp Resources/* "$APP/Contents/Resources/"
python3 - "$APP/Contents/Info.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'wb') as f:
 plistlib.dump(dict(CFBundleIdentifier='com.aispea.ringhi.flasher',CFBundleName='RingHi Flasher',CFBundleDisplayName='RingHi Flasher',CFBundleExecutable='RingHi Flasher',CFBundleShortVersionString='0.4.5',CFBundleVersion='405',CFBundlePackageType='APPL',CFBundleIconFile='RingHi.icns',LSMinimumSystemVersion='13.0',NSHighResolutionCapable=True,NSPrincipalClass='NSApplication',NSHumanReadableCopyright='RingHi'),f)
PY
xattr -cr "$APP"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
printf '%s\n' "$APP"
