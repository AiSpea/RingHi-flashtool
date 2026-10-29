# RingHi Flasher

RingHi 双芯片本地烧录工具。通过板载 USB Hub 配对 ESP32-S3 与 ML307H，逐板备份、并行烧录、授权，并执行兼容固件提供的产测流程。

## 安装

- **Windows 0.5.16**：[EXE 安装包与发布说明](https://github.com/AiSpea/RingHi-flashtool/releases/tag/v0.5.16)。Windows 10/11 x64，Python + Qt 原生界面，自带运行环境。安装器沿用已有安装位置，保留账号、配置、CSV 和外部备份。旧 Electron / C# 用户请手动安装一次 EXE。
- **Mac 0.4.10**：[PKG 安装包与发布说明](https://github.com/AiSpea/RingHi-flashtool/releases/tag/mac-v0.4.10)。Apple Silicon、macOS 13+，SwiftUI / AppKit 原生界面，覆盖 `/Applications/RingHi Flasher.app`。没有 Intel 包。

安装包未取得 Windows 代码签名或 Apple Developer ID 签名、公证；部分电脑可能阻止首次安装。安装包不包含用户的密码、PC 注册码、固件或生产 CSV。新电脑需要配置官方授权账号及兼容的设备驱动。

## 使用

1. 选择产品类型（SIM + eSIM 或双 SIM 卡槽），再选择适用的 ESP32-S3 完整 16 MB BIN、ML307H PKG、备份目录及官方授权项目。
2. 开启新批次，先新建 CSV；取消或保存失败不会接收设备。准备完成后处理已接入和新插入的板卡。
3. 同一板载 Hub 对应一行，两芯独立烧录。ML307 默认自动激活。开启产测时，产测、云端登记及最终报告上传均确认并完成收尾后才判整板成功。
4. 成功设备仍保留在当前接入列表，拔出后归档；重新插入建立新任务。CSV 持续保存，也可导出。
5. 暂停接收不打断在途任务。退出时可取消；确认退出则停止任务、释放端口并保存记录。中断设备需按恢复提示处理。

授权与云端登记需要网络，产测还需要兼容固件、工厂 Wi-Fi 及适用 SIM/eSIM。软件验证通过不代表所有硬件或网络环境已验证。

## 更新

Windows 首页自动检查公开 Release。空闲时点击更新，下载并校验 SHA-256，保存记录后退出、原位安装并自动重新打开，无需重启电脑。接收或烧录中不能更新，下载期间不能开启或恢复批次。Python 0.5.5 及更早版本使用兼容 ZIP 升级。

Mac 原生版从 0.4.9 起自动检查更新，首页左下角提示新版本；空闲时点击即可校验下载、保存 CSV、原位覆盖并重启。0.4.8 及更早需先使用 PKG 覆盖一次。Mac 发布使用独立标签，不改变 Windows 的 latest 更新入口。

更新固定直连 GitHub，不携带仓库访问令牌；网络不可达或校验失败不会安装。公开资产以 Release 的 SHA256SUMS.txt 校验清单为准。

## 源码与验证

- [Windows Python 原生版](native/python/README.md)：构建、依赖、许可和 [0.5.16 验证记录及已知限制](native/python/VALIDATION-0.5.16.md)。
- [Mac Swift 原生版](native/macos/README.md)：构建、依赖、许可和 [0.4.10 验证记录](native/macos/VALIDATION-0.4.10.md)。

当前根目录 Node/Electron 源码及其 `npm` 构建脚本仅用于保留旧版 0.3.x，不是以上原生安装包的构建入口。旧版 GitHub Actions 只匹配 `v0.3.*` 标签。原生安装包按各目录构建、验证后手动上传完整草稿 Release，再公开发布。

协议来源与第三方声明见 [架构说明](docs/architecture.md) 和 [第三方资源](renderer/upstream/vendor/THIRD_PARTY.md)。
