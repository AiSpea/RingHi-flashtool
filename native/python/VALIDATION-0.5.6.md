# RingHi Windows 0.5.6 — installer and update validation

2026-10-26. Python-native application; this release does not change firmware protocols.

- Local and Windows regression: 97 passed. Packaged UI: passed, including updating locks New Batch, active tasks block update, failed download unlocks controls, CSV export, cancel close, and interrupted-task CSV persistence. Hardware writes and activation requests in these tests: zero.
- Inno Setup EXE installed over the existing Desktop/RingHi-Native-Preview application. Installer exit 0; one RingHi uninstall entry; desktop shortcut targets the same executable. 69 account/settings/CSV files unchanged by SHA-256.
- Production-generated update helper exercised against the actual installed app: ready before parent exit, normal GUI close, silent EXE replacement, automatic relaunch, responsive new process, same executable path. The same 69 files remained unchanged. This is a local installer/update-helper test, not yet a public-release download test.
- A second silent install while the app was running exited with code 5 and preserved the running process. Installer refuses replacement while the application mutex is held and never force-closes hardware tasks. App initiates update only after receiving is paused and active tasks finish; download locks batch creation. CSV/settings save must complete before the helper starts. Helper startup failure preserves the app window.
- All app HTTP requests bypass proxy settings and retain TLS validation. Release selection requires an exact-version native EXE and SHA256SUMS.txt. A compatibility ZIP is provided for Python clients through 0.5.5. Old Electron/C# clients are not claimed to migrate automatically; use the EXE installer.
- User data remains outside application payload and is not removed on uninstall. Bundle contains no device firmware, account files, tokens, CSV histories or activation receipts.

Limits: unsigned Windows application/installer; Smart App Control trust and clean-machine driver installation have not been certified. No physical flashing was performed for 0.5.6. Online release download verification is recorded separately after publishing.
