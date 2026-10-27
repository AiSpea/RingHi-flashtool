# 产品类型判定软件验证 — 2026-10-27

基于新获取的 RingHi-flashtool origin/main c56f88be，在独立 codex/product-types 工作树实现。协议核对来自 simhelper origin/main 61fd0bdc 的 docs/FACTORY_PRODUCTION.md 和 firmware/src/factory_test.h。本次没有修改或发布固件、云端服务。

Windows 0.5.7：本机与 Windows 134 项测试通过。Windows 源码 UI 与打包后的 EXE UI 检查通过：两种产品选择、配置保存恢复、批次类型固定、保存 CSV 后才扫描/授权、CSV 导出、取消关闭、确认关闭后中断记录落盘、更新时禁止接收及表格无内部滚动条。测试 hardwareWrites=0、activationRequests=0、scanCalls=0。已生成 EXE 测试安装包并复制 Windows 桌面；未覆盖正在使用的应用，未公开发布。

Mac 0.4.6：原生 arm64 构建、签名完整性与 192 项隔离软件检查通过，生成 PKG 测试包。新增覆盖双空槽允许/eSIM 产品拒绝、两种卡槽位置的 EID、普通 SIM/CPIN 不能代替 EID、授权/云端/上传门槛、存储与卡槽恢复异常、取消及未终态不可通过、CSV 原始结果保留、旧记录不追溯分类。未覆盖当前安装应用，未验证新版界面实机点击或新机安装。

同一批次固定产品类型，调整界面只影响下一个新批次；继续当前批次沿用原类型。默认 SIM + eSIM，不根据 EID 缺失自动降级。

兼容边界：现有 volte-card-v3 不按 profile 改变有卡检查。仅对已知无卡失败原因且两槽均明确 empty/none 的原始结果应用双 SIM 规则；保留原始 stage 和 sim 明细，不将通信/恢复错误伪报为空槽。工具判定可能与旧固件灯效、云端原始产测结论不同，两者在记录中明确区分。实际云端登记和最终报告上传仍须完成。本轮不宣称任何新板实烧、eSIM 读取或云端真实登记成功。
