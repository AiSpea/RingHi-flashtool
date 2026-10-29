# Windows 0.5.12 factory reliability validation

Base: fetched `origin/main` at `79b7d97b78d023fccff2c597fdf2fa2d14d7a711`. This change is in the Windows Python application; device firmware and macOS source are unchanged.

## Findings and limits

- 0.5.11 invalidated a prepared batch's permission proof after 60 seconds. Each subsequent board could be held before writing by a redundant `projects` request. The batch already retained its project key material.
- Aggregate historical statistics on the test workstation showed 63 `projects` connection failures, 66 successful project responses, and 54 successful responses each for activation keys and activation reports. These are not logs from the reporting factory computer and do not establish that every factory failure has the same cause.
- The old launcher inherited the frozen application's environment and DLL search directory, and assigned the process job after esptool had started. Child creation/exit could race job assignment. The factory's original complete startup error is unavailable, so a specific factory exception has not been reproduced.
- Supplied official DT/FUT packages were inspected locally, not executed or redistributed. Their native library uses WinHTTP and the same authorization service/port. Their manual separates login/project selection from per-device activation; a login timeout is not a guarantee of a permanent TCP connection.
- A read-only comparison on the Windows test host used the public service root, no credentials or activation calls: four direct WinHTTP requests and four direct Requests requests all returned HTTP 200. Reused connections measured 63–78 ms and 61–63 ms respectively. This does not prove factory-network reachability or authenticated endpoint availability.

## Changes

- Keep authorization proof for the prepared account/project/token context, with no 60-second polling. Invalidate on explicit refresh, context change, or session rejection. Recover an explicitly rejected session once; do not replay ambiguous device authorization requests.
- Preserve exclusive healthy connection reuse and direct-only networking. Device-specific activation and confirmation are still required.
- Launch esptool with an independent PyInstaller environment; temporarily restore system DLL lookup while creating the child. Create the process suspended, assign its kill-on-close Job, then resume it. Preserve descendant cancellation.
- After CSV creation and before scanning boards, run the pinned official esptool's version command. Include system error/exit code in errors, including empty-output failures. Task details support copying the full saved state/log.

## Software verification

Windows Python 3.13.17, PyInstaller 6.22.3. `python -m pytest tests -q`: **205 passed**. Includes permission reuse over 72 hours, changed contexts, explicit session recovery, ambiguous delivery protection, concurrent launches, nonzero/no-output failures, cancellation and descendant cleanup, and the actual official engine's eight version checks across four workers.

Commands:

```powershell
.venv/Scripts/python.exe -m pytest tests -q
.venv/Scripts/python.exe main.py --ui-test test-results/0512-ui
./build.ps1
./dist/RingHi/RingHi.exe --engine-test test-results/0512-engine.json
./dist/RingHi/RingHi.exe --ui-test test-results/0512-packaged
./installer/build-installer.ps1
```

No serial port is opened by `--engine-test`. UI tests use isolated data and no hardware scanner. Physical blank-board flashing and the affected factory computer remain unverified in this change.


Packaged EXE: eight real official-engine launches with four workers passed in 2.46 seconds. Isolated packaged UI report passed CSV-before-scan, export equivalence, close cancellation, interrupted-task CSV persistence, product selection and update locking; zero hardware writes, activation requests or scan calls.

Installed over 0.5.11 at the existing Windows path: installer exit 0, one uninstall entry, 226 pre-existing account/configuration/record/CSV file hashes unchanged. The previous application was backed up and closed normally only after the UI was idle and no hardware worker remained. Installed-engine eight-launch check passed in 2.34 seconds, without port access.

Installer SHA-256: `598a6a51a5af30348821982937b470e2738f0b3f63470729680746b079c51cd1`.
Compatible ZIP SHA-256: `1d0d8c212dc8be2ee9946037012ff786074ce33858477f9059c1796a05d23746`.
The downloaded EXE matches the Windows build hash. A copy is on the Windows desktop. This task has not published a GitHub Release or changed the public update feed.

Post-install desktop verification: 0.5.12 visible, automatic login successful, product control present, window responsive, new-batch action enabled, receiving disabled and zero hardware worker processes. No physical flashing was initiated.
