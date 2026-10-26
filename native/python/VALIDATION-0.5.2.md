# RingHi Python 0.5.2 — page scrolling and CSV start gate

2026-10-26. Scope: device-table painting, scrolling, new-batch initiation and metadata version. Hardware protocols and success gates remain unchanged.

## Behavior

- Connected and unplugged tables expand to show every row; neither table has an internal horizontal or vertical scrollbar. Columns fit the available viewport, including result and details. Full long values remain in tooltips/details. Wheel events over device rows scroll the outer page.
- A Qt item delegate paints cells. UI refresh compares only displayed fields, retains existing items, and updates changed rows; no per-cell widget trees are recreated on each progress update.
- New Batch opens the CSV save dialog first. An exclusive file creation writes, flushes, fsyncs and verifies the CSV header before firmware checks, authorization preparation, batch construction or scanning. Cancel, write failure and existing filenames cannot start device tasks. Existing CSVs are never overwritten as new batches.
- Firmware snapshot and initial batch save run on the preparation thread rather than the UI thread.

## Verification

Core tests: 64 passed locally and on Windows. UI fixture exercises CSV cancel, preexisting file preservation, injected disk-full failure, saved-file-before-authorization/start order, all configuration controls, eight fully expanded devices, all seven columns at 1080px window width, wheel forwarding, stable table item/widget counts, details dialog, CSV export and cancel/confirm close. These checks perform no hardware writes or activation calls.

Windows offscreen Qt comparison: 8 devices, all progress values changed on each iteration, 60 iterations per version at 1080 x 760, identical render/update/event-processing harness. Version 0.5.1 mean 114.97 ms, p95 177.94 ms, max 191.05 ms. Version 0.5.2 mean 7.99 ms, p95 9.15 ms, max 9.38 ms. This is a synthetic source-UI workload, not physical flashing speed or a guarantee for every display/driver.

No public release or push performed. No physical burning performed for this UI update.

Deployment: previous window closed normally without force. Installed over Desktop/RingHi-Native-Preview and reopened. 64 account/configuration/CSV files matched pre-deployment SHA-256. Packaged UI regression passed, including detail dialog and CSV write-error gating. Release zip SHA-256: 19979cea59d9ea44c808c9c79840d77c446a5a053b66fe8d3844307acedb4fa6.
