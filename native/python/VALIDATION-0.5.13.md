# Windows 0.5.13 ESP32 recovery validation

Base is `origin/main` 79b7d97 plus the locally tested 0.5.12 fixes. No firmware, ML307 activation protocol or macOS source changes.

## Root issue and changes

Pinned esptool 5.6.0 source, `cmds.reset_chip`: `no-reset` invokes `soft_reset(True)` when a stub is running; `no-reset-stub` keeps the stub. Separate identify/write/verify processes previously exited the stub on every step and immediately reopened the port. This creates an avoidable reset/re-enumeration window, though it does not establish the exact cause of the original factory error without its log.

ESP32 now keeps the stub between operations, refreshes the same board's topology before each open, waits through delayed enumeration, and performs bounded read-only connection recovery. Windows process job shutdown waits for zero active owned processes before releasing the per-port lock. Other applications' processes are never terminated to seize a port.

Only explicit pre-connect failures may reissue a write command. Any connected/erase/write evidence prevents an automatic write replay. Read-only verification may recover through identity confirmation; a changed MAC, ambiguous port, removed board, changed hub generation, launch error or incomplete cleanup fails closed.

## Software tests

Windows: **223 pytest tests passed**, plus isolated source UI tests (CSV before scan/authorization, CSV export, cancel-close, final CSV preservation, update locking, product controls). New cases cover delayed port arrival without consuming reset attempts, changed COM path, download reset sequencing, transient occupation, process tree cleanup, same-port exclusion with cross-port concurrency, changed identity, unplug cancellation and no replay after write may have started.

Device identity and production logs are not included in this document. Physical recovery tests use the attached board without writing flash or contacting activation services; results are recorded separately from simulated tests.

Source execution on one attached physical board, without unplugging:

- Three successive no-reset-stub reconnects: passed, 2.33–2.34 seconds each, same MAC confirmed internally.
- Real Windows serial handle held by the test for three seconds, then released: automatic recovery passed in 6.46 seconds.
- Official USB download reset and reconnect: passed in 2.96 seconds.
- Injected stale COM path followed by fresh same-board lookup: recovered in 4.07 seconds. This simulates a stale mapping, not an observed Windows COM renumbering.
- Final hard-reset command: accepted in 1.44 seconds. Application Wi-Fi/cloud behavior was not tested.

No flash writes or activation requests were made. This board was already flashed; a factory blank-chip write and arbitrary driver/hardware faults are not proven by these tests.

Frozen EXE execution on the same physical board also passed all seven checks without unplugging: stub reconnects 2.34–2.35 s, temporary occupied port recovery 6.38 s, USB download reset/reconnect 2.96 s, injected stale COM recovery 4.02 s, final reset command 1.44 s. Identity equality was checked locally. Zero flash writes and zero activation requests. The same packaged EXE passed eight parallel official engine version launches and isolated CSV/UI/close checks.

Original-path installation over 0.5.12 completed with exit code 0 and one uninstall entry. The previous app was backed up; hashes of 226 existing account/configuration/record/CSV files remained unchanged. Installed engine parallel self-check passed (eight launches, four workers, 2.39 s). An installer copy was placed on the Windows desktop.

EXE SHA-256: `3e547b88b115ea778760ebb63376f2a591f2e55b9c298031499f5fffb1e1e0f2`. The downloaded delivery EXE matches this hash.
ZIP SHA-256: `658c28ccc297b71f9778238d15dfa62e41be9355c2b6959833110ad53a009d6c`.

The installer contains its dependencies and installs without a GitHub download. Public GitHub Release/update feeds were not changed in this task.

Post-install desktop check confirmed version 0.5.13, automatic login, responsive UI, available product control/new-batch button, receiving disabled and no hardware workers. The application is left open and idle.
