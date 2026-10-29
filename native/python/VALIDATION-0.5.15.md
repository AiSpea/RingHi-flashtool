# Windows 0.5.15 reset-handle recovery validation

Baseline: fetched origin/main `87db723aef74aa2bb08dbeaab6cf8a6e6a870928`.

## Reported failure and correction

Factory screenshots show ML307 97% with `ClearCommError failed (PermissionError(13, '设备不识别此命令。', None, 22))`. In 0.5.14, 97% is after completed Flash writes and official activation, while sending/reading the loader reset. The reset code only accepted Windows disconnect codes 6/31/995/1167, so error 22 escaped before runtime verification. The Python exception class does not establish an authorization/account problem. The specific factory driver/USB reason for code 22 has not been reproduced naturally on the test host.

Reset transport errors now leave the receipt unconfirmed, without replaying reset, firmware writes or activation. The old handle closes; the original Hub/chip is resolved again; matching IMEI and RingHi runtime firmware are mandatory before ML307 reaches 100%. Boot-time pySerial errors permit fresh same-device opens within a bounded 60-second verification window. Wrong identity, wrong firmware, protocol rejection/corrupt ACK and startup timeout remain failures. Download/write error handling is unchanged. Receipt and original diagnostic persist in transaction records and device details.

The provided official DLL also calls ClearCommError. Static inspection does not prove that official software never receives this driver error, or provide evidence for treating it as account permission failure. Reset response handling and post-reset startup verification are separate stages in this fix.

## Software validation

Windows Python regression: **281 passed**. Includes exact factory error 22 at reset read/write, other transport codes, same errors during Flash writes remaining fatal, cancellation, malformed/refused ACK, real-identity gate after uncertain reset, persistent runtime failure timeout, new COM resolution and four independent concurrent reset outcomes. Existing authorization recovery and production/cloud gates remain covered.

## Four-board hardware run: source plus fault injection

User explicitly authorized all four attached boards, and requested focusing on downloads because factory Wi-Fi is absent. This validation alone sets production off; persisted production configuration stays enabled. `wholeBoardPassed=false` and cloud count zero are explicit in the report; no production/cloud pass is claimed.

Using the user's selected ESP32-S3 152 factory 16 MB BIN and ML307 v26.019 full PKG:

- Four complete dual-chip transactions, all ESP32 and ML307 progress 100%, **60.7 seconds** after batch startup (login/preparation excluded).
- Observed peak concurrent boards=4, ML307=4, ESP32=4.
- Two real-board runs injected the exact error-22 exception only when reading the reset receipt, after the actual reset write. These are controlled fault injections, not a natural reproduction on the factory computer.
- The other two naturally returned reset-read Windows error 995. All four independently reached matching runtime identity and verified transaction phase.
- All four local activation ledgers are complete; original backups exist; CSV saved; no unfinished rows. No manual unplug or power cycle was used.

## Frozen EXE and overwrite installation

- Source UI and packaged UI/CSV/close verification passed: no real hardware writes; CSV reservation precedes authorization/scanning; cancel/failure prevents start; export bytes match; cancel-close keeps the window; confirmed close saves interrupted rows. Eight-row scrolling retains no inner scrollbars and does not rebuild widgets.
- Packaged official ESP engine: eight launches/four workers passed, 2.81 seconds. Installed engine check also passed, 2.38 seconds, without port access.
- Inno Setup overwrite from 0.5.14 to 0.5.15 exited 0 at the original installation directory. One uninstall entry remains. **879** existing account, settings, record, CSV and backup files retain identical hashes. Old application archived; installed EXE hash equals the tested build.
- macOS AppleDouble transfer metadata is excluded from the distributable; no source credentials or local production records are packaged.

## Installed EXE: normal four-board complete burn

Launched the actual installed EXE with `--hardware-test ... --hardware-boards 4 --hardware-flash-only`; no injected faults. All four ESP32s passed full MD5 verification and all four ML307s completed writes, official activation and matching boot identity. Runtime **61.2 seconds** after batch startup. Peak concurrency=4 boards / 4 ESP32s / 4 ML307s.

All four naturally produced reset-read Windows error 995; each recovered and reached verified phase. No natural Windows error 22 occurred on this host. This run and the earlier controlled two-board error-22 injection must not be described as a natural reproduction on the factory's computer. Both four-board rounds completed without unplugging between rounds.

Final CSV contains exactly four rows, matches the final in-memory records byte for byte, retains BOM, and records production as unexecuted. Four ESP ports and four ML307 runtime ports were present after completion. Persisted production setting stays enabled. Actual factory Wi-Fi, SIM/eSIM, cloud registration and final report upload remain **unvalidated in this run**; their production gates are not bypassed in the product. These are already programmed test boards, not a blank-chip first-write validation.

## Delivery

Windows desktop and local delivery copy: `RingHi-Setup-0.5.15-win-x64.exe`, 59,777,861 bytes.

SHA-256: `c44072b885ca6f30b69698187ea436d56fa70cf895158cda87d834bec2d168a4`.

The copied local installer matches the Windows build manifest. No public release has been made for this candidate. Detailed device/backup/activation records stay on Windows; copied test summaries contain no device IDs or credentials.

## Follow-up stability check (supersedes any broad stability inference)

Five additional four-board rounds on 0.5.15 produced **19 successful tasks and 1 failure**. Three rounds used the installed EXE; two used the GUI-equivalent account snapshot/batch lifecycle in one process. The second in-process round exposed a real ESP32 failure after reporting the full 16 MB write, before MD5 completed: Windows `Cannot configure port`, error 22, followed by a listed-but-unopenable COM port. All 20 ML307 transactions passed. The failed record and CSV remain failed. Two previously successful rounds do not establish factory reliability. Work on 0.5.16 addresses completed-write verification recovery and this Windows device-state failure; it has not yet been accepted or delivered at this point.
