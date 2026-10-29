# Windows 0.5.14 ML307 port and activation recovery validation

Date: 2026-10-29. Base: fetched `origin/main` 79b7d97 plus the existing local 0.5.12/0.5.13 fixes. No firmware, macOS source, public Release or update-feed changes in this task.

## Findings and changes

The factory report was Windows 0.5.13, ML307 at 92%, with a generic driver-not-ready error. Its complete log and the two affected factory boards were unavailable. The following findings explain reproduced software faults, not a conclusive diagnosis of that factory incident.

The supplied official FUT DLL keeps the reset transport open while awaiting a response. The old Python path wrote reset and immediately closed. It also converted missing-mode and open errors into one generic driver message. The recovery path could still display 92% while waiting for runtime identity after activation.

ML307 now refreshes the same board/chip/generation topology before opening, waits through AT/download enumeration gaps, and permits one identity-checked fallback reset only while the original runtime interface remains present. It does not select another board's port. Open timeouts identify the requested mode and preserve the actual system error.

Reset holds the handle until acknowledgement, expected disconnect, or a bounded timeout. Windows errors 6/31/995/1167 are accepted as a disconnect only during reset or runtime identity reconnection. They do not prove successful boot. Runtime identity and RingHi firmware must still be confirmed. The same error during Flash writes remains fatal and never replays an uncertain write.

Activation completion and original backups survive a failed reset/readback. A confirmed activation followed by a pending startup check resumes that check without another ML307 write or activation. Recovery still requires matching firmware, MAC, UID, authorization project and original backups. Progress distinguishes activation, reset (97%) and startup verification (98%). Production, actual cloud registration and final report requirements remain intact.

## Software and frozen application

- Windows regression: **258 tests passed** in the final build.
- Isolated source and frozen UI checks passed: CSV before authorization/scan, cancellation and save failure prevent startup, CSV export equality, product settings, update locking, cancel-close and interrupted CSV save.
- Frozen official esptool startup: eight launches with four workers passed in 2.50 seconds; no serial access during this test.
- Recovery cases include stale COM paths, temporary busy handles, delayed enumeration, cancellation, wrong identity, completed-activation recovery, durable state before reset, acknowledgement/timeout/disconnect, and no replay of Flash writes after Windows 995.

## Physical evidence and limits

One previously flashed test board was used, not a blank factory board. Selected images were ESP32-S3-152-factory-16MB.bin and RingHi-ML307H-v26.019.rh36a8e3a15015-full.pkg. Detailed identities and raw logs remain on the test workstation.

An initial RAM-loader-only diagnostic failed to return the modem to runtime. Subsequent handshakes also stopped responding. The user power-cycled once. This diagnostic did not erase/write firmware or request activation. The reason for this RAM-only behavior is not conclusively established, and the temporary diagnostic entry point was removed from the shipped source.

The first full source burn completed ESP32 MD5 verification and ML307 writing/official activation, but exposed Windows ClearCommError 995 on the reset disconnect. The runtime port actually returned. This reproduced error was fixed with the scoped disconnect handling above.

Without another unplug, the next source batch completed ML307 startup verification from its saved activation result and ESP32 MD5 verification. Both chips reached 100%. Production failed waiting for AiSpea_Factory Wi-Fi; cloud registration was not confirmed. CSV saved. This proves recovery of a completed activation, not recovery of every possible uncertain network transaction.

The final frozen EXE then performed a fresh complete dual-chip burn. ML307 reached 100% through writing, activation, reset and startup verification; ESP32 reached 100% with MD5 verification. Both runtime and ESP ports remained present. Production again timed out waiting for AiSpea_Factory Wi-Fi, and cloud completion stayed false. The board result correctly remained failed and the CSV was saved. This is a passing flashing/recovery test, not a passing end-to-end production/cloud test.

Factory blank-board behavior, arbitrary broken drivers/power, the original two factory failures and a real response-uncertain activation are not established by this single-board test. Software timeout and recovery tests do not replace those physical cases.

## Installer

Installer AppId and original installation directory are unchanged. The package includes dependencies and needs no GitHub download during installation. Account credentials remain locally encrypted and are not embedded in the installer.

EXE SHA-256: `d623475edfc25c83a3d0784b1581624554e4e5201a1a12fb562e05b1d594124b`.

Original-path installation over 0.5.13 completed with exit code 0. The old application was backed up. Hashes of **825** existing account/configuration/record/CSV/backup files remained unchanged. There is one uninstall entry, now version 0.5.14; the installed EXE matches the tested build. Installed official engine checks passed eight launches/four workers in 2.41 seconds. A copy of the installer is on the Windows desktop; the local delivery EXE matches the Windows SHA-256 above.

Post-install desktop verification confirmed version 0.5.14, automatic login, responsive UI, product controls, new-batch availability, receiving disabled and zero hardware workers. The installed application is left open and idle.
