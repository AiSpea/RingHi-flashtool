# RingHi macOS 原生版

0.4.5，Apple Silicon（arm64），最低 macOS 13。SwiftUI / AppKit 原生界面，无 Electron / WebView。
ESP32 使用随包自带的乐鑫官方 esptool 5.6.0（自带 Python）；ML307 使用 libusb、Swift 下载协议与官方授权服务。

## 0.4.5 修复

- 官方服务固定直连，关闭 HTTP / HTTPS / SOCKS / PAC 自动代理设置；仍验证 TLS 证书。
- 开启批次先新建、同步并校验 CSV；取消或已有文件不会开始授权和烧录，固件准备与快照写入移到后台。
- 读取 ESP32 身份后，写入及独立 MD5 复核不再重复触发 USB 复位。
- 设备激活允许更长的响应等待；收到的授权回执先存入系统钥匙串，再继续写设备。关闭请求到达时不丢弃已经确认的服务响应。
- 仍不自动重放结果不明的设备激活请求。本轮只做软件验证，不据此宣称空板实烧通过。

## 使用

打开原有 `RingHi Flasher.app`，选择左右两侧固件、ML307 备份目录和授权项目。开启新批次时选择 CSV 文件，随后自动处理已接入及新插入的 RingHi。

- 同一板载 Hub 对应一行；双芯独立线程烧录，支持仅烧 ESP32 或 ML307。
- 当前 ESP32 支持 S3 完整 16 MB BIN、0x0 地址；写入校验后另做完整 MD5。
- ML307 默认自动激活，不提供跳过激活的开关。设备专属分区保存并复读校验后才能写入。
- 产测要求兼容 `volte-card-v3`，产测、云端登记及最终报告上传均确认后才判整板成功。
- 停止接收不打断在途任务，可继续本批次。拔出取消原任务，重插建立新记录。
- 未完成的 ML307 写入或授权会保留恢复线索，并阻止盲目重试；需核对原备份。
- 退出时确认取消任务，等待端口和子进程释放，再保存 CSV；保存失败时保持应用打开。
- 原生版当前通过安装包原位更新，尚未接入自动更新。不会读取 Electron 更新提示。

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
./native/macos/package.sh /absolute/path/RingHi-Native-0.4.5-mac-arm64.pkg
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
