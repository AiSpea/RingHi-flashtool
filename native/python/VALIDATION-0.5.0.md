# RingHi Python 0.5.0 — internal Windows validation

Date: 2026-10-26. Windows host: win-tailor-windows. This build is installed locally; no commit, push or public release was performed.

## Implementation

Python 3.13 + PySide6 / Qt Widgets replaces the Windows C# application. Serial enumeration uses Windows SetupAPI/CfgMgr via ctypes. ESP32 runs hash-pinned official esptool 5.6.0. ML307 framing, bootloaders, protected partition backup, write, authorization and boot verification are Python code. A per-Hub generation lease separates reconnect attempts; workers finish and release handles before a replacement task runs. Default activation, production/cloud/report gates, CSV atomic saving and close cancellation are preserved.

Account DPAPI files, project selection, settings, historical records, activation ledgers and recovery intents use the original user-data directory. No credentials are bundled. Existing incomplete activation requests remain blocked against automatic replay.

## Evidence

- macOS-hosted Python core regression: 63 passed. Static checks F/E9 passed.
- Windows Python core regression: 63 passed.
- Final standalone packaged exe: isolated Qt UI test passed. Unplug/replug scheduling, archived/current rows, CSV byte-identical export, cancel-close and confirm-close with interrupted CSV were exercised. 95 UI heartbeats; maximum observed gap 63.73 ms. This measures the synthetic QA workload only.
- Packaged UI screenshots inspected: Chinese and Latin text readable, vector icons rendered; firmware configuration is side-by-side.
- Read-only Windows probe: 5 ESP/ML pairs found, 3 ML runtime and 2 ML download mode. All 3 runtime ML devices passed model/IMEI/version query. No firmware writes or activation requests were made.
- Existing encrypted account login succeeded, 5 projects returned, selected project 188 and batch common materials prepared. Account file unchanged.
- Proxy diagnosis: anonymous official-service requests through the configured localhost proxy failed with TLS EOF; verified direct TLS requests succeeded. Login now selects a route using an anonymous health GET. It does not replay activation POSTs after uncertain outcomes. Windows system trust is used, with TLS verification enabled.
- Deployment retained the original Desktop/RingHi-Native-Preview path. 63 existing account/configuration/CSV files matched pre-deployment SHA-256. Old application archived under Documents/RingHi-App-Backups.
- Same interactive Windows desktop session confirmed main window title RingHi, responsive true, and zero hardware worker processes. The app is idle, no batch started.

## Artifact

Windows: Documents/RingHi-Python-Source/releases/RingHi-Python-0.5.0-win-x64.zip
SHA-256: 2fc3d99cab29107ea806175d0d99e764e06f29e112fbc1859039e974efaf4c83

The zip contains RingHi/RingHi.exe plus its _internal directory; users need not install Python. Keep the full folder together.

## Remaining physical validation

No end-to-end physical burn, power-interruption recovery, fresh per-device activation or actual production/cloud upload was executed using this Python release. The 2 download-mode boards have not been claimed recovered. Unit and UI fixtures do not prove USB transport stability or successful programming. Automatic public-release replacement has source-level checks, but a published Python-to-Python upgrade has not yet been exercised. macOS is unchanged in this Windows rewrite.
