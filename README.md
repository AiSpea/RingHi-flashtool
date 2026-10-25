# RingHi Flasher

RingHi 双芯片本地烧录工具，支持 Windows x64 和 Apple Silicon Mac。每块板通过板载 USB Hub 配对 ESP32-S3 与 ML307H，逐板备份、并行烧录、授权，并可自动执行固件提供的产测流程。

## 安装与使用

从 [Releases](https://github.com/AiSpea/RingHi-flashtool/releases/latest) 下载对应平台的包：Windows 为便携 EXE，直接运行；Mac 为 PKG，固定安装到 `/Applications/RingHi Flasher.app`。尚未代码签名或公证；不提供 Intel Mac 安装包。

首次运行需要自备适用的 ESP32 BIN、ML307H PKG、授权账号和官方 PC 注册码。账号仅加密保存于本机，不包含在源码或安装包内。Windows 须安装兼容的 ML307H 运行与下载驱动，工具不会替换系统驱动。

1. 选择两个固件与实际写入地址，确认适用型号；选择 ML307H 备份目录及授权项目。
2. 开启新批次并选择独立 CSV 文件，插入板卡后自动识别 MAC、配对并烧录；开启批次时已连接的板卡也会处理。
3. 自动产测需支持 FACTORY 命令的 RingHi 固件、工厂 Wi-Fi 和适用的 SIM/eSIM。整板成功要求双芯烧录、产测、云端登记及最终报告上传全部通过，并完成端口/记录收尾。
4. 成功设备保持在接入列表，拔出后归档；重新插入生成新任务。CSV 持续保存并支持历史导出。

单芯片批量模式可分别处理 ESP32 或 ML307H。单板手动页按 ML307H → ESP32 顺序执行。退出时可取消，或停止任务、保存记录后退出；中断后的设备需要重新烧录或复测。

## 自动检查与覆盖更新（0.3.19 起）

启动后及每 6 小时自动检查 GitHub Releases；也可在“说明与更新”手动检查。发现新版本仅提示，不会自动下载或打断烧录。

停止接收并等待当前任务完成后，点击“下载新版本”。下载成功并通过 SHA-256 校验后，点击“退出并安装更新”：Windows 原路径替换便携 EXE 并重新打开，旧 EXE 保留为 `.previous`；Mac 打开系统安装器，由用户按系统提示覆盖原应用。账号、记录、CSV、外部备份保留。

0.3.18 及更早版本没有检查更新功能，需要手动安装一次 0.3.19。网络不可用、下载不完整或校验失败时不会安装。Windows 原文件被占用时等待退出，不强制终止其他任务。更新依赖 GitHub 访问能力，不嵌入 GitHub 访问令牌。

## 开发与发布

Node.js 24：`npm ci`、`npm test`、`npm start`。构建：`npm run build:win` / `npm run build:mac`。两端使用相同源代码；`npmRebuild: false` 配合依赖提供的预编译原生绑定。

发布前更新 `package.json`、`package-lock.json` 的版本和 `release-notes.txt`。推送匹配版本的 `vX.Y.Z` tag 后，GitHub Actions 在两种系统上测试并构建，生成 `ringhi-update.json`，先完整上传草稿 Release，再发布为最新版本。只有发布正式 Release 才提示更新，单纯 push 源码不会提示。手动打包时可用 `node scripts/make-update-manifest.cjs <两个包所在目录>` 生成同样清单。

协议来源与第三方声明见 [架构说明](docs/architecture.md) 和 [第三方资源](renderer/upstream/vendor/THIRD_PARTY.md)。硬件与软件验证分开记录，见 [验证范围](docs/validation.md)。
