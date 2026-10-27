# RingHi macOS 原生版

0.4.8，Apple Silicon（arm64），最低 macOS 13。SwiftUI / AppKit 原生界面，无 Electron / WebView。
ESP32 使用随包自带的乐鑫官方 esptool 5.6.0（自带 Python）；ML307 使用 libusb、Swift 下载协议与官方授权服务。

## 产品类型

新批次选择「SIM 卡槽 + eSIM 芯片」或「双 SIM 卡槽」，默认前者。类型随批次固定，切换选择仅对新批次生效；继续接收使用原批次类型。选择保存在本机，批次记录、任务详情及 CSV 保存类型、eSIM 检查和设备原始产测结果。

- SIM + eSIM：要求 Wi-Fi、VoLTE 授权、有卡检查通过，且报告至少一槽明确为 euicc/read 并包含有效 EID 尾号。普通 SIM 或 CPIN 有响应不能替代 EID。
- 双 SIM：Wi-Fi、VoLTE 授权及实际云端登记仍须通过，不要求 EID。现有 volte-card-v3 固件的已知无卡、SIM selection/communication failed 和精确匹配的恢复卡槽 deadline 失败按可选卡槽检查处理；不要求卡槽快照，存储、取消或未知异常不豁免。
- 两种类型都等待本轮最终报告上传、端口及记录收尾；未启用产测时不宣称通过产品产测。

本次只改变烧录工具的判定，不修改设备原始报告、灯效或云端后台的产测规则。旧固件可能仍将双空槽报告标为 failed，工具 CSV 保留该原始结果并明确显示 eSIM 不适用；云端登记必须是真实确认。旧记录没有产品类型时保持未记录，不追溯改判历史结果。

## 0.4.5 修复

- 官方服务固定直连，关闭 HTTP / HTTPS / SOCKS / PAC 自动代理设置；仍验证 TLS 证书。
- 开启批次先新建、同步并校验 CSV；取消或已有文件不会开始授权和烧录，固件准备与快照写入移到后台。
- 读取 ESP32 身份后，写入及独立 MD5 复核不再重复触发 USB 复位。
- 设备激活允许更长的响应等待；收到的授权回执先存入系统钥匙串，再继续写设备。关闭请求到达时不丢弃已经确认的服务响应。
- 同一任务不自动重放结果不明的设备激活请求；新任务经原设备/项目/备份核对后可以恢复，原回执先归档。软件验证不代表空板实烧通过。

## 使用

打开原有 `RingHi Flasher.app`，选择左右两侧固件、ML307 备份目录和授权项目。开启新批次时选择 CSV 文件，随后自动处理已接入及新插入的 RingHi。

- 同一板载 Hub 对应一行；双芯独立线程烧录，支持仅烧 ESP32 或 ML307。
- 当前 ESP32 支持 S3 完整 16 MB BIN、0x0 地址；写入校验后另做完整 MD5。
- ML307 默认自动激活，不提供跳过激活的开关。设备专属分区保存并复读校验后才能写入。
- 产测要求兼容 `volte-card-v3`，产测、云端登记及最终报告上传均确认后才判整板成功。
- 停止接收不打断在途任务，可继续本批次。拔出取消原任务，重插建立新记录。
- 未完成的 ML307 写入或授权会保留恢复线索，并阻止盲目重试；需核对原备份。
- 退出时确认取消任务，等待端口和子进程释放，再保存 CSV；保存失败时保持应用打开。
- 原生版启动后及每 6 小时自动检查 Mac 发布版本；左下角提示新版本，「说明与更新」可手动检查。点击后校验下载、保存 CSV、覆盖当前应用并重启，烧录/接收/登录期间禁止升级。

## 数据和升级

保持原应用路径 `/Applications/RingHi Flasher.app` 和 bundle ID `com.aispea.ringhi.flasher`。
原生配置在 `~/Library/Application Support/ringhi-flasher/native-macos`；原 Electron 数据与历史记录保留不动。
首次运行尝试从原 Electron safeStorage 和系统钥匙串迁移账号，成功后放入原生钥匙串条目。
旧备份目录和授权项目自动沿用。新电脑需自行配置官方账号、密码、PC 注册码；安装包不含这些数据。
当前测试包仅使用本地 ad-hoc 签名，未进行 Apple Developer ID 签名/公证；不代表已验证跨电脑首次安装。

## 构建

Xcode Swift 6.3.3（Swift 5 语言模式），目标 `arm64-apple-macos13.0`。
准备 `Tools/esptool`、`Tools/libusb-1.0.0.dylib` 和随附源代码归档（来源和哈希见 `Resources/NOTICE.txt`）。

```
./native/macos/build.sh
./native/macos/package.sh /absolute/path/RingHi-Native-0.4.9-mac-arm64.pkg
```

产物默认放在 `/private/tmp/ringhi-native-macos-build.noindex`，避开同步目录给 `.app` 添加 FinderInfo 导致的签名失败。
签名只签原生程序和自带库；esptool 从官方发布文件校验后仅重做 ad-hoc 签名，并以固定 SHA256 再验证。
安装包禁止重定位，升级时替换整个旧应用，避免残留 Electron Frameworks。

## 软件验证

```
'/private/tmp/ringhi-native-macos-build.noindex/RingHi Flasher.app/Contents/MacOS/RingHi Flasher' --self-test
```

自检创建独立 `/tmp/ringhi-native-tests-*`，不打开硬件、不登录、不激活。测试进程组终止时需正常 macOS 权限，否则终端沙箱可能限制发送信号。
`--ui-test` 仅用于开发窗口验证，数据明确标记为软件验证，并存入隔离临时目录；正常启动没有模拟设备或演练入口。

## 批次授权准备

开启批次时一次获取所选项目的公共授权材料，准备完成后才接收设备。同一批次后续板卡在核对型号、MAC、IMEI 后直接开始烧录，不再逐台获取公共材料。公共材料只保存在内存，取消准备、结束批次或退出后释放；切换账号或项目必须重新准备。

公共材料获取遇到指定的临时网络错误最多尝试两次；证书信任错误和登录失效不自动重试。每台设备的独有激活码仍在烧录后联网领取，结果不明时不自动重领。断网无法保证完成设备激活与云端产测登记。

0.4.7 同步 Windows 0.5.8–0.5.10：下拉控件禁止滚轮误改；双 SIM 产品只对已知可选卡槽错误免检，仍等待授权、云端登记及报告上传；重烧前恢复主卡槽，已写固件的未完成授权可在原设备、项目、固件及备份核对后恢复。中断在固件写入/备份阶段仍需保留原备份人工核对。详见 `VALIDATION-0.4.7.md`。

## 0.4.8 连接和恢复

官方请求共用 URLSession 连接池，每个任务有独立响应和取消状态；账号快照不再为每次请求新建连接。不使用代理、不放宽 TLS 校验、不自动重放结果未知的设备授权请求。Mac 原有批次公共材料准备和逐台激活机制保留。

同 MAC 的旧卡槽 IMEI 别名记录，只有后续已验证记录、相同硬件 UID、原固件、完整备份及完成的授权能相互印证时才自动选择，历史不删除。下载模式新增已完成或尚未写入任务的安全重烧入口，实际 ROM UID 再核对后才写入；保存原备份链和验证时间。中断在分区写入/备份阶段仍需人工核对，不宣称任意断点恢复。详见 `VALIDATION-0.4.8.md`。

## Mac 自动更新（0.4.9 起）

- Mac 从公开 GitHub Releases 列表选取 `mac-vX.Y.Z`，忽略 Windows、draft 和 prerelease；不占用 Windows 的 `/releases/latest`。版本必须带精确命名的 `RingHi-Native-X.Y.Z-mac-arm64.zip` 和 `SHA256SUMS.txt`。
- `package.sh` 同时生成首次安装/手动覆盖用 PKG、自动更新 ZIP 和校验清单。先上传并核对两种产物，再公开 Mac Release；使用 `--latest=false`。
- 更新网络匿名直连，禁止代理和 cookies；限制 HTTPS 跳转、下载大小、ZIP 路径/链接/展开大小，校验 SHA-256、bundle ID、版本和本地代码签名。当前为 ad-hoc 签名，尚未 Developer ID 签名或公证。
- 升级前停止接收、等待任务完成。先保存当前 CSV 和配置；失败则不退出。新应用的独立助手等待旧进程结束，在同一目录构建候选副本，再换入原路径；写入或签名复核失败恢复旧副本。新窗口启动后清理隐藏旧副本。受保护目录可能要求系统管理员授权，钥匙串可能要求再次允许读取原账号。
- 应用更新不覆盖 `native-macos` 配置、钥匙串、生产记录、用户选择的 CSV 或设备备份。临时下载文件位于系统临时目录。
- 0.4.8 及更早原生版需先手动覆盖安装一次。此功能与旧 Electron 更新器无关。

验证命令（不打开硬件、不调用授权）：

```sh
'/path/to/RingHi Flasher.app/Contents/MacOS/RingHi Flasher' --verify-update-archive /path/to/RingHi-Native-0.4.9-mac-arm64.zip
RINGHI_CHECK_FROM_VERSION=0.4.8 '/path/to/RingHi Flasher.app/Contents/MacOS/RingHi Flasher' --check-mac-update
```

`--ui-test` 使用隔离数据和不可下载的更新提示样例，验证忙碌时升级禁用及关闭保存；不代表真实网络升级或实物烧录。
