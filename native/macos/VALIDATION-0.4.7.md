# macOS 0.4.7 同步 Windows 近期修正

2026-10-27。已 fetch origin，HEAD 与 origin/main 均为 c56f88be。沿用现有产品类型工作；仅改 native/macos，未改 Windows、设备固件、云端或公开 Release。

## 同步行为

- 四个选择控件（授权项目、产品类型、烧录范围、并行板数）使用 AppKit NSPopUpButton，滚轮交给页面；产品类型改为下拉框，点击/键盘选择保留。
- 双 SIM 产品对 volte-card-v3 已知三类可选卡槽失败采用 Windows 0.5.9 判定：无卡、SIM selection/communication failed，以及精确匹配的恢复卡槽 deadline 失败。仍要求 Wi-Fi/VoLTE 通过、终态、真实云端登记与报告上传成功；未知异常、存储/取消等不会豁免。sim_esim 仍要求有效 EID。原报告及失败原因保留。
- RingHi 运行固件先确认主卡槽 0，再读用于烧录的 IMEI；stock 模块不添加切槽命令。
- 新任务可以恢复同设备、同项目、同固件、原备份的 activating/awaiting-verification。先核对 MAC、IMEI、备份哈希与路径，再在下载器核对真实 UID。只加载 RAM 下载器、恢复授权和复位核验，不重复擦写已写固件。旧 ledger 和钥匙串回执先归档，归档失败不开始请求。每个任务仍只尝试一次，未知结果不会冒充成功。
- 下载模式现在能进入受限恢复预检；中断在固件写入或备份阶段仍拒绝自动处理，不能将此版本理解为任意断点刷写恢复。重复授权额度语义沿用 Windows 的产品约定，未独立验证官方计费。

## 验证与部署

- arm64 编译、ad-hoc 签名与严格校验通过；230 项自检通过。涵盖产品判定/云端门槛、主卡槽恢复失败、授权阶段与上下文不匹配、CSV、取消与进程收尾。日志 /tmp/ringhi-mac-047-tests.log。没有连接硬件或请求云端激活。
- 安装包 RingHi-Native-0.4.7-mac-arm64.pkg SHA256: 0cde9a764f07768d34a576baeecc718a86e0d19a05f6234825aec793e4eec562。
- /Applications/RingHi Flasher.app 从 0.4.5 原位替换为 0.4.7；旧应用压缩备份 RingHi-Mac-before-0.4.7.zip。安装前后 117 个配置/历史记录文件 SHA256 一致，钥匙串未修改；未创建第二个 Applications 应用。
- CUA 实际窗口显示 0.4.7、未开启批次。对四个弹出控件滚动，值不变而页面滚动位置变化。产品类型展开并点击“双 SIM 卡槽”成功；选中后再次滚动也不改变，随后恢复测试前 SIM + eSIM 选择。
- 本次未做物理烧录、恢复授权实机或新固件产测验证。启动时账号登录仍在等待网络，未声称在线登录验证通过。未提交、推送或公开发布。
