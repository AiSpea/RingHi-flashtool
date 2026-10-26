# macOS 原生 0.4.1 软件验证 — 2026-10-26

## 交付范围

Apple Silicon / macOS 13+；当前电脑完成原生构建、签名完整性检查、软件回归、原生 UI 交互、原位更新、账号迁移与重新启动验证。
用户指定仅软件验证。本轮没有打开任何板卡的烧录接口，没有发起激活/领取授权，没有实物烧录或 Wi-Fi/SIM 产测。

## 已验证

- 88 项自动检查全部通过。包括 CRC/checksum/分片和异常应答、真实 PKG 结构及保护分区、S3 16 MB BIN 校验、官方输出解析与双 MD5 完成判定、Hub 配对歧义和连接代次、云端/报告严格门槛、CSV 中文/BOM/标识符/公式防护、任务拔出重插、停止继续、成功设备保留、退出任务释放、导出一致性。
- 独立进程组的取消在 2 秒内完成，子进程不再运行；超时也会回收进程。安装包内 esptool 5.6.0 可正常启动，固定 SHA256 检查通过。
- 原生 UI 隔离验证：双进度条及 MAC 可见；退出弹出取消/停止并关闭；取消后任务继续；原生保存框导出 CSV 成功；停止并关闭后进程退出，自动保存 CSV 中原任务为“已中断”。
- 正常应用的首次自动登录从旧 safeStorage 成功迁移至 macOS 钥匙串。五个官方授权项目完整列出，原选择的项目沿用。只做登录和项目查询，未调用激活服务。
- 旧备份目录沿用；旧加密账号与备份配置文件 SHA256 前后一致。原 CSV、batches、jobs 和固件目录均未更改。
- 旧应用空闲后正常退出，先生成经过 ZIP 完整性检查的备份，再替换 `/Applications/RingHi Flasher.app`，仍为同一 bundle ID。正常原生应用退出后进程消失，重新打开配置保留。
- 原生包包含自带 libusb（部署目标 13.0）与官方 esptool，未链接 Homebrew 路径；旧 Electron Frameworks 已完全移除。
- pkg 检查显示固定 Applications 路径、relocatable=false、strict identifier、upgrade-bundle；运行中安装会要求先退出。当前电脑通过同路径替换验证应用运行，未声称验证过新电脑上系统 Installer/Gatekeeper 首次安装。

## 包

`RingHi-Native-0.4.1-mac-arm64.pkg`

SHA256: `8cf223bba4d75ed25fc9a255128c070470157afa41d72dc2025b2a82e07edc5c`

本地 ad-hoc 签名，未 Developer ID 签名/公证。未发布 GitHub Release，未接入原生自动更新。没有改动 Windows 版本。

## 限制与待验证

- macOS 实物端点占用、下载模式切换、双板并发、掉线时序、实物复位、授权及工厂 Wi-Fi/SIM 流程仍需接板测试，不能用本轮软件通过代替。
- 最低系统目标为 macOS 13，但本轮只在当前 macOS 主机运行；未验证所有受支持系统版本。无 Intel 包。
- ML307 按正式协议应答、授权回执和复位身份验证完成，不宣称做了全 Flash 读回比对。
- 当前 ESP32 限定 ESP32-S3 / 完整 16 MB BIN / 0x0；不是旧版通用多段烧录器。

## 证据

工作区 `../../work/native-macos-evidence/` 内保存构建日志、88 项测试日志、UI 导出/退出 CSV、旧文件校验清单。旧应用 ZIP 保存在 `../../work/app-backups.noindex/`。
测试数据均在独立 `/tmp/ringhi-native-tests-*` 和 `/private/tmp/ringhi-native-ui-check`，未混入正式批次。
