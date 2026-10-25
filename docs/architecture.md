# 来源与扩展

来源仓库：https://github.com/AiSpea/ToolBox.git

复用基线：`11c80ab27b656acdc7419dbb22654db24aff44ed`。

- `renderer/upstream/ml307h/*`：原 PKG、下载协议、USB/串口、备份恢复、AFS 功能激活模块。
- `renderer/upstream/ml307h-flash.js`：基于原工作台增加运行开始、完成、结束回调和准备状态查询，原解析、备份和下载流程保留。
- `renderer/upstream/esp-flash-core.mjs`：原 BIN 布局与配置校验。
- `renderer/upstream/vendor/`：原 esptool-js 0.6.0 离线包及 Apache-2.0 声明。
- `desktop/spark.cjs`：移植原 `ml307h_account.py`，只允许固定官方 HTTPS 地址及操作、禁止重定向、不自动重试、响应限长。
- `desktop/main.cjs`：Electron 隔离窗口、本地静态页面、设备选择、限制来源的 IPC、本地任务日志。未使用远端页面或开放 HTTP 控制接口。
- `core/job.mjs`：逐步骤状态机；ML307H/ESP32 结果分开记录，失败则跳过后续步骤。
- `renderer/esp.mjs`：预期芯片匹配、压缩写入、MD5 校验、复位、连接释放。

采用 Electron 设备权限与选择事件，参考官方资料：https://www.electronjs.org/docs/latest/tutorial/devices 。页面不具备 Node 权限；预加载层仅暴露指定操作。令牌及激活密钥不写磁盘。默认账号通过 `desktop/default-account.cjs` 使用系统 safeStorage 加密，独立保存于用户数据目录。

产测扩展方向：增加板级 profile（固件地址、芯片、接口关系），在现有步骤状态机扩展 `boot-check`、联网/信号、音频回环、按键/灯、序列号核对等适配器。每项明确输入、超时、通过条件及输出证据，并单独存入任务记录。现阶段仅预留状态字段和分步结构，没有实现或伪造这些检查。

当前支持同一电脑多板并行，单板页面保留双芯片顺序执行。默认账号可一次性配置到本机并在启动时登录；不将服务端密码打入发行包。首次实机验收前需核对 RingHi 固件与板卡下载路径。


## RingHi board batches (0.3.0)

- `desktop/native/topology.cjs`: physical USB bus / port routes, OS serial joins and direct-parent-hub pairing. The Windows PnP helper follows ancestors; macOS parses IORegistry location IDs. Ambiguous controller mappings or multiple matching children never become ready.
- `desktop/native/service.cjs`: Node-API USB / serial resources in the main process. A lease captures the physical hub incarnation and child routes. Download reconnect is restricted to the leased ML route. Hotplug invalidates replaced hub leases. No renderer-supplied filesystem path can open an arbitrary serial device. Native reads are bounded, independent queues; USB writes verify actual byte counts and preserve ZLP framing.
- `renderer/native.mjs`: narrow IPC transports, including a Web Streams serial adapter compatible with the existing esptool-js loader.
- `renderer/ml-batch.mjs`: per-board AT identity, verified backup session, original downloader / burn / optional activation code, and independent progress. No global singleton ML lease is used in batches; the original single-board flow retains its original guard.
- `core/board-batch.mjs`: identify both chips, persist MAC / IMEI, then launch two independent writes. Whole-board success requires all selected chip jobs and the journal to succeed. The MAC / IMEI map retains failed and passed claims throughout the batch. Replug merges the visible row rather than retrying writes.
- `renderer/batch.mjs`: firmware recipe, one arm action, automatic discovery, two progress bars, overall result and per-board logs. Account settings and file choices lock during the batch. Machine sleep is inhibited while armed / busy.

The previous ESP-only queue remains covered by tests but the active UI now uses board batches. Recovery continues through the single-board workbench with the original backup directory. Production tests remain an independent not-run field.

Native dependencies are pinned and use bundled Node-API prebuilds for macOS arm64 and Windows x64. `npmRebuild` is disabled for cross-packaging; both native package prebuild directories are unpacked from ASAR. Runtime loading must be checked on each target platform.

API references: [node-usb](https://github.com/node-usb/node-usb), [SerialPort](https://serialport.io/docs/api-serialport/). API and simulated tests do not replace physical board validation.
