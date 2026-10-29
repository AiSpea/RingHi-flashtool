# Mac 0.4.10 recovery synchronization

Date: 2026-10-29. Source baseline: fetched origin/main 79b7d97. Windows counterpart: 0.5.14. Native Swift/AppKit/libusb remains the Mac implementation; Windows-specific serial error numbers and process/DLL handling are not copied into Mac.

## Behavior

ML307 mode switching tolerates a gap with neither interface present. The one fallback reset requires the original runtime interface and matching identity; appearance of the download interface cancels the fallback. Each open refreshes the original board topology and connection generation. Missing mode, invalid/ambiguous interface, temporary access/busy and transport disconnect remain distinct errors.

Reset writes once and waits for acknowledgement, libusb no-device or a bounded timeout. Only subsequent runtime IMEI/firmware verification proves success. Acknowledged activation is saved before reset, so a disconnected reset does not discard completion. A completed activation with pending startup verification only verifies startup, without another download/write/activation. Matching original device, firmware, authorization project and backups are still required. Reset and startup wait are shown at 97% and 98% respectively.

USB errors are retried only for bounded opening/startup reads; corrupted/rejected protocol replies and uncertain Flash writes remain failures. Production, cloud registration and final upload gates are unchanged.

ESP32 now preserves the official download stub between separate tool invocations. Batch startup verifies the bundled engine version before hardware/authentication work. A measured standalone version query took 23.55 seconds on this host; a startup stack sample showed Python dynamic-library loading/signature registration. The prior 20-second test limit could therefore fail without a port operation. Version preflight is bounded at 60 seconds and cancellable; no system security settings were changed. This does not prove that every slow startup has that cause or improve the system's signature-check speed.

## Validation scope

Native Apple Silicon/macOS 13 build and strict ad-hoc code-signature verification passed. The final bundle passed **337 self-tests**, including the real official esptool startup and read-only parsing of the current factory PKG/BIN. Tests exercise delayed enumeration, busy/missing handles, cancellation cleanup, fallback at most once, identity mismatch, boot reconnect, reset acknowledgement/disconnect/rejection, bounded waits and no replay after uncertain write, alongside existing update/CSV/product checks.

The actual isolated UI was tested with no hardware scan or authorization: closing a simulated in-flight task prompted; cancel preserved the task; confirming close exited and saved one interrupted CSV record. The ZIP passed the production updater's path/size/link validator. Original installed applications, account credentials and production data were not changed by these tests.

No Mac physical board was burned in this turn. Windows physical evidence is separately recorded in `../python/VALIDATION-0.5.14.md`; it does not establish Mac USB behavior. The previous RAM-loader-only reset limitation and lack of the original factory failure boards remain relevant. The user will perform Mac hardware testing.

The PKG retains the existing bundle ID and `/Applications/RingHi Flasher.app` destination. The ZIP uses the existing in-place updater and separate `mac-v` release feed. No credentials, CSV production records, firmware or device backups are included. Packaging remains ad-hoc signed without Developer ID notarization.

## Package hashes

```text
60fa006b484d2d930d417c8944947e101d8611a886182dab8ae0e707f8ae5b07  RingHi-Native-0.4.10-mac-arm64.pkg
12601c540dbd41c382f5824e6f5541579e6a10601b237d95627e764a2a0c022b  RingHi-Native-0.4.10-mac-arm64.zip
```
