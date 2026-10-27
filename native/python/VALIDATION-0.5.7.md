# 产品类型判定软件验证 — 2026-10-27

基于新获取的 RingHi-flashtool origin/main c56f88be，在独立 codex/product-types 工作树实现。协议核对来自 simhelper origin/main 61fd0bdc 的 docs/FACTORY_PRODUCTION.md 和 firmware/src/factory_test.h。本次没有修改或发布固件、云端服务。

Windows 0.5.7：本机与 Windows 134 项测试通过。Windows 源码 UI 与打包后的 EXE UI 检查通过：两种产品选择、配置保存恢复、批次类型固定、保存 CSV 后才扫描/授权、CSV 导出、取消关闭、确认关闭后中断记录落盘、更新时禁止接收及表格无内部滚动条。测试 hardwareWrites=0、activationRequests=0、scanCalls=0。已生成 EXE 测试安装包并复制 Windows 桌面；未覆盖正在使用的应用，未公开发布。

Mac 0.4.6：原生 arm64 构建、签名完整性与 192 项隔离软件检查通过，生成 PKG 测试包。新增覆盖双空槽允许/eSIM 产品拒绝、两种卡槽位置的 EID、普通 SIM/CPIN 不能代替 EID、授权/云端/上传门槛、存储与卡槽恢复异常、取消及未终态不可通过、CSV 原始结果保留、旧记录不追溯分类。未覆盖当前安装应用，未验证新版界面实机点击或新机安装。

同一批次固定产品类型，调整界面只影响下一个新批次；继续当前批次沿用原类型。默认 SIM + eSIM，不根据 EID 缺失自动降级。

兼容边界：现有 volte-card-v3 不按 profile 改变有卡检查。仅对已知无卡失败原因且两槽均明确 empty/none 的原始结果应用双 SIM 规则；保留原始 stage 和 sim 明细，不将通信/恢复错误伪报为空槽。工具判定可能与旧固件灯效、云端原始产测结论不同，两者在记录中明确区分。实际云端登记和最终报告上传仍须完成。本轮不宣称任何新板实烧、eSIM 读取或云端真实登记成功。

## Windows 覆盖更新验收

按用户后续明确要求，等待旧版在途任务结束、暂停接收并正常关闭后，备份旧应用并在原 Desktop/RingHi-Native-Preview 路径覆盖安装 0.5.7。安装器退出 0，注册项仍只有一个 RingHi，安装后主程序与验证包哈希一致；142 个账号、配置、CSV 和批次记录文件安装前后 SHA256 相同。

实际桌面窗口已重新打开，版本 0.5.7、自动登录成功、产品类型入口可见且响应正常。开启新批次可用，接收关闭，esptool/espflash/RecoveryBatch 进程为零。本次更新没有发起实烧；等待期间旧版结束的两台任务分别保留 IMEI 不一致与空槽检查失败，未重判历史记录。

## 2026-10-27 两块已授权板卡现场恢复

用户授权尝试恢复，并随后限定“先恢复当前两块”。未测试未接入的 MAC 尾号 1D:98，也未证明官方重复请求的额度语义。

Windows 当前两块 MAC 尾号 C4:50（COM25）、C3:A8（COM43）均有本机 verified 烧录记录及 complete 官方授权回执，但在产测恢复 SIM 槽失败后停于 SIM 槽 1。只读 AT+CGSN=1 在两块均返回同一尾号 2354，与另一条旧 intent 匹配，导致预检查误报“上次授权结果未确认”。AT+CGSN/AT+GSN 返回不同模块序列号；不是仅凭 COM 次序推断设备。

暂停应用接收后，分别使用当前固件已有的 AT^SIMSLOT=0、AT^AEM=1,"ACT" 恢复槽 0。两条命令均返回 OK；两块 IMEI 分别恢复为原记录尾号 8113、8055。分别运行原 0.5.7 modem.preflight，均通过“型号与 IMEI 已确认”；再次独立只读查询，仍与各自 verified 记录和 MAC 对应。

本次 firmwareWrites=0、activationRequests=0，未修改授权 ledger、原始备份或历史 CSV，未把先前产测失败改为成功。恢复诊断在 Windows native-preview/diagnostics/slot-recovery-* 的 result.json。应用仍暂停接收；本次仅为现场状态恢复，没有打包、安装、发布或声称自动恢复逻辑已修复。
