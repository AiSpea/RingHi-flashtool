# 验证范围

## 0.3.18 已有证据

- Mac 实机两块 RingHi 同时烧录，ML307H 分别约 25 / 27 秒，包含逐板备份、下载和授权；两板 ESP32 最终 MD5 均一致。
- 两板产测、云端登记、最终报告上传均通过，整板约 99 / 100 秒。一次小样本不能代表量产长期稳定性。
- 一块 ESP32 有两次明确 0xC1 拒绝后的有界重传，另一块无重传；根因尚未定位。超时、断连不会按校验拒绝处理。
- 本地 201 项软件测试、Windows 84 项针对性测试与启动检查通过。Windows 0.3.18 未重新执行实物烧录。

## 0.3.20 更新功能

更新清单、版本比较、平台匹配、HTTPS 跳转边界、下载损坏与中断、SHA-256、重复请求、忙碌保护、保存 CSV 后交接安装器由软件回归验证。安装包未签名，不宣称静默通过系统安全检查。发布记录中应另行记录各平台覆盖更新实测，不能用单元测试代替。

产测通过仅覆盖固件报告的项目，不能代替音频、通话、外观或长期稳定性验收。

## 0.3.21 断连与重新开始

- 本地与 Windows 各通过 226 项软件测试，新增覆盖驱动写入/关闭无回调、Hub 拔出时取消任务、同一设备重插、晚到的旧任务结果、停止后新批次及端口临时枚举缺失。
- 隔离 Electron 界面使用模拟硬件，验证 99% 等待时拔出、失败终态、重插成功、停止后重新开始；真实本地 CSV 分别保留 2 条与 1 条任务。
- 软件回归不代表同事电脑的 USB 驱动或实物断电烧录已验收。归芯授权网络失败仍须人工核对，不自动重复领取。

## 0.3.22 退出通知

- 单向 IPC 通知不使用抛异常的请求检查：关闭或安装更新期间忽略晚到的设备选择和忙碌状态，继续接收来自本应用窗口的退出快照；非本窗口通知始终拒绝。
- 本地与 Windows 各通过 229 项软件测试。隔离的真实 Electron 退出回归覆盖空闲关闭、取消关闭后任务仍在、确认关闭后中断记录与 CSV 落盘、关闭期间迟到通知；不连接或烧录实物。
- Mac 与 Windows 安装包共用退出逻辑；发布前校验包内运行时代码与源代码一致，并验证匿名下载及 SHA-256。

## 0.3.23 首页更新入口

保留启动后与每 6 小时自动检查；新版本在侧栏底部提示，一次点击串联下载与安装交接。下载失败、校验失败、重复点击和设备任务忙碌均不可触发安装。Windows 沿用覆盖 EXE 并重新打开的安装器；Mac 沿用系统 PKG 安装器，仍需系统确认。界面模拟更新源不代表执行真实升级，公开下载与包校验另行记录。

## 0.3.25 安装器启动确认

Windows 正式 0.3.22 → 0.3.23 的真实在线测试发现：公开下载与校验成功，点击安装后应用退出但未覆盖。安装器启动逻辑增加持久工作目录、唯一就绪回执和日志，主进程收到回执后才退出。0.3.24 仅作内部旧版客户端验证，正式包使用 0.3.25。Windows 直连 GitHub 下载很慢，本地已有代理也报连接关闭；实际下载测试通过仅监听回环的临时 SSH 通道使用 Mac 既有代理，系统代理设置保持不变。账号/项目密文、6 条任务、2 个已有 CSV 的 11 个文件在首次失败后逐字节保持不变。正式跨版本一键升级结果与自动重启证据需另行保存，不以外部启动安装脚本代替。


## Windows updater host correction (0.3.26)

The 0.3.25 attempt was withdrawn after the actual portable app did not replace itself. Minimal Electron tests on the Windows desktop showed PowerShell with detached=true exited with status 0 without executing either plain or encoded commands. Ordinary child creation executed the commands but did not survive the Electron parent. This matches Node issue https://github.com/nodejs/node/issues/51018. A GUI-subsystem .NET host now survives the parent and starts hidden PowerShell with valid redirected handles. The desktop probe confirmed readiness before parent exit and completion after exit. The install script still performs all target/package hash checks, backup, replacement and restart.

The host source is desktop/update-host.cs; rebuild it on Windows with scripts/build-update-host.ps1 before packaging after source changes. The binary is included so cross-platform packaging does not need a Windows compiler. No scheduled task, elevated token, system proxy or execution-policy change is used by the product updater. Full installed one-click upgrade evidence is tracked separately from these software and process-lifecycle checks.
