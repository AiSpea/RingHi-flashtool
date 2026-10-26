# RingHi Python 0.5.1 — UI spacing update

2026-10-26. Scope: presentation only; hardware protocols, pairing, scheduling, authorization, production success gates and CSV persistence are unchanged.

- Split batch metrics into four readable groups, with CSV status/export in the same batch card.
- Keep ML307 and ESP32 firmware selection side by side; move shared mode, concurrency and production controls into a separate card.
- Increase section spacing, table row padding and identity/progress width. Display percent, progress bar and status on separate lines. Long values retain full tooltips and the existing detail dialog.
- Preserve two tables: connected devices remain until unplugged; archived attempts remain below. Empty tables are compact; narrow windows allow horizontal scrolling instead of crushing columns.
- Preserve login, project choice, backup folder, three burn modes, six concurrency options, production checkbox, pause/resume, CSV export, records, updates and close confirmation.

Validation: Windows core regression 63 passed. Source and packaged UI checks passed, including all configuration controls, side-by-side file fields, unplug/replug, CSV byte-identical export and cancel/confirm close. Inspected 1440 x 940 and 1080 x 760 layouts. Packaged synthetic run maximum GUI heartbeat gap 66.85 ms. No hardware writes, activation calls or live device scans in these UI tests. This is software/layout evidence only.

Deployment: old window closed through its normal close handler, without forcing. Installed over Desktop/RingHi-Native-Preview. 63 existing account/configuration/CSV files matched pre-deployment hashes. Windows release zip SHA-256: 5515a479dd2e04f849b05d24c895197b88f34284db67973ed596364eea1b7862. No public release or push performed.
