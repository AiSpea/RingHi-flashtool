# Windows 0.5.9 双 SIM 软件验收

基线 origin/main c56f88be，在现有 0.5.8 及产品类型工作上继续修改。用户明确要求不修改 152 固件，双空 SIM 产品不因可选 SIM/eSIM 检查及其恢复卡槽错误被判整板失败。

## 判定

仅对明确选择 dual_sim 的批次，将 volte-card-v3 已知的无卡结果、SIM selection/communication failed，以及 Cannot restore SIM slot after eUICC check: SIM selection/activation did not respond within deadline 按产品免检处理。无需证明槽内有卡或读到 EID，不把这些失败描述成固件原始检查通过。

仍要求本轮 Wi-Fi、VoLTE 授权通过；等待真实 cloudRegistered=true、pendingUpload=false、upload=uploaded 后才成功。未知异常、存储问题、取消、中断、非终态、缺少必检项、轮次变化等仍不能通过。sim_esim 产品保持原有 EID 和 SIM 检查要求。界面显示卡槽/eSIM 不参与该产品判定，CSV/详情保留原始 stage 和 sim 原因。已存失败记录不追溯改判。

## 软件验证

本机 177 项测试通过。新增/调整覆盖三种可选卡槽失败、缺失/错误卡槽快照、不同产品判定、原报告不变、原始失败明细保留、等待登记→等待上传→成功的完整软件流程，以及 Wi-Fi/VoLTE/存储错误仍失败。使用的恢复卡槽错误文本与 Windows 16:26:58 两条记录一致；fixture 的云端成功状态为测试数据，不代表两条历史失败当时已完成云端登记。

本轮没有接入设备，不修改固件、云端、账号授权记录，也不声明实物产测已验证。当前仅更新 Windows；Mac 未改此判定。

Windows 177 项回归也通过；源码 UI 和打包 EXE UI 均通过，含 CSV 保存门槛、产品类型持久化/批次锁定、导出一致、正常/取消关闭、更新保护及无内部滚动条。打包检查 hardwareWrites=0、activationRequests=0、scanCalls=0。EXE 安装包 SHA256：540cac62be96c19075b39256041826aa80bb6e1d1f9da9869c9506315a6c8f07，大小 59,753,562 bytes。

实际覆盖安装成功：安装器退出 0，路径仍为 C:/Users/AssAs/Desktop/RingHi-Native-Preview，卸载项仍一个 RingHi。170 个账号、配置、CSV/批次记录文件安装前后 SHA256 相同。旧应用已正常关闭并备份至 Documents/RingHi-App-Backups/Before-Setup-0.5.9-20261027-164442.zip。未提交、推送或公开发布。

覆盖后的实际桌面确认：0.5.9 可见、自动登录保留、窗口响应、产品控件存在、开启新批次可用、receiving=false、hardwareWorkers=0。取回的安装包 SHA256 与 Windows 构建一致。
