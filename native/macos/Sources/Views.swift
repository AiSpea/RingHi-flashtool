import AppKit
import SwiftUI

extension Color {
  static let ink = Color(red: 0.08, green: 0.17, blue: 0.20),
    teal = Color(red: 0.02, green: 0.49, blue: 0.42),
    canvas = Color(red: 0.95, green: 0.96, blue: 0.97),
    muted = Color(red: 0.40, green: 0.48, blue: 0.52),
    line = Color(red: 0.86, green: 0.89, blue: 0.90)
}
struct Card<Content: View>: View {
  var content: Content
  init(@ViewBuilder _ content: () -> Content) { self.content = content() }
  var body: some View {
    content.padding(24).frame(maxWidth: .infinity, alignment: .leading).background(Color.white)
      .clipShape(RoundedRectangle(cornerRadius: 18)).overlay(
        RoundedRectangle(cornerRadius: 18).stroke(Color.line, lineWidth: 1))
  }
}
struct Pill: View {
  var text: String
  var color: Color = .teal
  var body: some View {
    Text(text).font(.system(size: 12, weight: .semibold)).foregroundColor(color).padding(
      .horizontal, 12
    ).padding(.vertical, 7).background(color.opacity(0.08)).clipShape(Capsule())
  }
}
struct ActionButton: View {
  var title: String
  var icon: String
  var primary = false
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Label(title, systemImage: icon).font(.system(size: 13, weight: .semibold)).padding(
        .horizontal, 16
      ).padding(.vertical, 11).foregroundColor(primary ? .white : .teal).background(
        primary ? Color.teal : Color.teal.opacity(0.06)
      ).clipShape(RoundedRectangle(cornerRadius: 10))
    }.buttonStyle(.plain)
  }
}
struct Workspace: View {
  @ObservedObject var store: Store
  var body: some View {
    HStack(spacing: 0) {
      sidebar
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 24) {
            header
            summary
            configuration
            boardSection("02", "当前接入设备", store.connected, subtitle: "完成后保持在此，拔出后移到下方记录；重插会建立新任务。")
            boardSection("03", "已拔出记录", store.disconnected, subtitle: "成功、失败与中断结果均保留在本批次 CSV 中。")
              .id("history")
            about.id("about")
          }.padding(28)
        }.onChange(of: store.selection) { value in
          withAnimation {
            proxy.scrollTo(
              value == "history" ? "history" : value == "about" ? "about" : "top", anchor: .top)
          }
        }
      }.background(Color.canvas)
    }.frame(minWidth: 1140, minHeight: 760).font(.system(size: 13)).foregroundColor(.ink).sheet(
      isPresented: $store.showLogin
    ) { LoginView(store: store) }.overlay {
      if store.closing {
        Color.black.opacity(0.12).ignoresSafeArea()
        VStack(spacing: 16) {
          ProgressView()
          Text("停止任务并保存 CSV…").font(.headline)
        }.padding(30).background(.regularMaterial).clipShape(RoundedRectangle(cornerRadius: 18))
      }
    }
  }
  var sidebar: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 12) {
        if let url = Bundle.main.url(forResource: "ringhi", withExtension: "png"),
          let image = NSImage(contentsOf: url)
        {
          Image(nsImage: image).resizable().frame(width: 44, height: 44)
        }
        VStack(alignment: .leading, spacing: 5) {
          Text("RingHi").font(.system(size: 25, weight: .bold))
          Text("设备工作台").font(.system(size: 12)).foregroundColor(.white.opacity(0.6))
        }
      }.padding(.top, 38).padding(.bottom, 60)
      Text("工作空间").font(.system(size: 10, weight: .semibold)).tracking(3).foregroundColor(
        .white.opacity(0.45)
      ).padding(.bottom, 18)
      nav("batch", "批量烧录", "square.stack.3d.up")
      nav("history", "生产记录", "clock.arrow.circlepath")
      nav("about", "说明与更新", "info.circle")
      Spacer()
      Label(store.testing ? "软件验证 · 未操作实物" : "本地运行", systemImage: "circle.fill").font(
        .system(size: 11)
      ).foregroundColor(Color.mint)
      Text("macOS · 原生版 \(Disk.version)").font(.system(size: 11)).foregroundColor(
        .white.opacity(0.55)
      ).padding(.top, 10)
    }.padding(.horizontal, 22).padding(.bottom, 30).frame(width: 180).background(
      Color(red: 0.055, green: 0.19, blue: 0.20)
    ).foregroundColor(.white)
  }
  func nav(_ id: String, _ title: String, _ symbol: String) -> some View {
    Button {
      store.selection = id
    } label: {
      Label(title, systemImage: symbol).font(.system(size: 15, weight: .semibold)).frame(
        maxWidth: .infinity, alignment: .leading
      ).padding(.vertical, 17).padding(.horizontal, 12).background(
        store.selection == id ? Color.white.opacity(0.10) : .clear
      ).clipShape(RoundedRectangle(cornerRadius: 12))
    }.buttonStyle(.plain).padding(.bottom, 10)
  }
  var header: some View {
    HStack {
      VStack(alignment: .leading, spacing: 9) {
        Text("RINGHI / DEVICE WORKSTATION").font(.system(size: 10, weight: .bold)).tracking(2)
          .foregroundColor(.muted)
        Text("批量烧录").font(.system(size: 30, weight: .bold))
        Text("配置一次固件，插入设备后自动烧录，逐台查看完整结果。").foregroundColor(.muted)
      }
      Spacer()
      Pill(text: "原生设备烧录")
    }.id("top")
  }
  var summary: some View {
    Card {
      VStack(alignment: .leading, spacing: 20) {
        HStack {
          VStack(alignment: .leading, spacing: 8) {
            Text("插入即烧录").font(.system(size: 22, weight: .semibold))
            Text("按板载 Hub 自动配对，一行对应一块 RingHi。").foregroundColor(.muted)
          }
          Spacer()
          Pill(text: store.accepting ? "接收中" : store.busy ? "等待任务收尾" : "未开启批次")
        }
        HStack {
          metric("本批次任务", store.rows.count)
          metric(
            "正在执行",
            store.rows.filter {
              $0.state.endedAt.isEmpty && !["等待", "等待配对", "排队"].contains($0.state.result)
            }.count)
          metric("已成功", store.rows.filter { $0.state.result == "成功" }.count, color: .teal)
          metric(
            "需要处理", store.rows.filter { ["失败", "已中断"].contains($0.state.result) }.count, color: .red
          )
        }
        Divider()
        HStack {
          Label(store.scanText, systemImage: "cable.connector").foregroundColor(.muted)
          Spacer()
          if store.accepting {
            ActionButton(title: "停止接收", icon: "pause", action: store.stop)
          } else if store.batch != nil {
            ActionButton(title: "继续接收", icon: "play", action: store.resume).disabled(
              !store.batch!.error.isEmpty)
          }
          ActionButton(
            title: store.starting ? "检查配置…" : "开启新批次", icon: "plus", primary: true,
            action: store.start
          ).disabled(store.busy || store.accepting || store.starting)
        }
        if !store.csvPath.isEmpty {
          HStack(alignment: .top) {
            Image(systemName: "doc.text")
            Text("本批次 CSV：" + store.csvPath).font(.system(size: 12)).textSelection(.enabled)
            Spacer()
            Button("导出 CSV", action: store.export).buttonStyle(.plain).foregroundColor(.teal)
          }
        }
        Label(store.notice, systemImage: "info.circle").font(.system(size: 12)).foregroundColor(
          .muted
        ).textSelection(.enabled).padding(14).frame(maxWidth: .infinity, alignment: .leading)
          .background(Color.canvas).clipShape(RoundedRectangle(cornerRadius: 10))
      }
    }
  }
  func metric(_ title: String, _ count: Int, color: Color = .ink) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(String(count)).font(.system(size: 30, weight: .semibold)).foregroundColor(color)
      Text(title).foregroundColor(.muted)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
  var configuration: some View {
    Card {
      DisclosureGroup(isExpanded: $store.configExpanded) {
        VStack(alignment: .leading, spacing: 20) {
          HStack(alignment: .top, spacing: 24) {
            firmwareCard("01 / CELLULAR", "ML307H 固件与授权", store.mlPath, "ml") {
              VStack(alignment: .leading, spacing: 12) {
                Text("\(store.account) · 自动激活").foregroundColor(.teal)
                HStack {
                  Picker("授权项目", selection: $store.project) {
                    Text("请选择授权项目").tag(0)
                    ForEach(store.projects) { p in Text("\(p.name)（\(p.id)）").tag(p.id) }
                  }.labelsHidden()
                  Button(store.loginBusy ? "登录中…" : "登录 / 切换") { store.showLogin = true }.disabled(
                    store.loginBusy)
                }
                Button {
                  store.choose("backup")
                } label: {
                  Label("选择备份总目录", systemImage: "folder")
                }
                Text(store.backupPath.isEmpty ? "尚未选择目录" : store.backupPath).font(.system(size: 11))
                  .foregroundColor(.muted).textSelection(.enabled)
                Text("逐板备份校准与工厂数据，烧录后自动授权激活。").font(.system(size: 11)).foregroundColor(.muted)
              }
            }
            firmwareCard("02 / CONTROLLER", "ESP32 固件烧录", store.espPath, "esp") {
              VStack(alignment: .leading, spacing: 12) {
                Pill(text: "ESP32-S3 · 16 MB · 地址 0x0")
                Text("乐鑫官方 esptool 5.6.0").fontWeight(.medium)
                Text("完整 BIN 写入，保留固件头参数。写入及独立 MD5 校验通过后才显示完成。").foregroundColor(.muted).font(
                  .system(size: 12))
                Text("每颗芯片独立显示连接、写入与校验状态。").foregroundColor(.muted).font(.system(size: 12))
              }
            }
          }
          Divider()
          HStack(spacing: 24) {
            Picker("烧录范围", selection: $store.mode) {
              Text("双芯烧录").tag("dual")
              Text("仅 ESP32").tag("esp")
              Text("仅 ML307H").tag("ml")
            }.frame(width: 230)
            Picker("并行板数", selection: $store.limit) {
              ForEach([1, 2, 3, 4, 6, 8], id: \.self) { Text("\($0) 台").tag($0) }
            }.frame(width: 150)
            Spacer()
          }
          Toggle("烧录后自动产测；产测、云端登记和报告上传全部确认后才算整板成功", isOn: $store.production).toggleStyle(.checkbox)
          Text("产测需要 AiSpea_Factory 工厂 Wi-Fi 和测试 SIM / eSIM。").font(.system(size: 11))
            .foregroundColor(.muted)
        }.padding(.top, 20).disabled(store.locked)
      } label: {
        HStack(spacing: 12) {
          Text("01").foregroundColor(.muted)
          Text("固件与接入配置").font(.system(size: 17, weight: .semibold))
          Spacer()
          Text(store.locked ? "本批次配置已锁定" : "左右分别配置两个芯片").font(.system(size: 12)).foregroundColor(
            .muted)
        }
      }
    }
  }
  func firmwareCard<Content: View>(
    _ eyebrow: String, _ title: String, _ path: String, _ role: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      Text(eyebrow).font(.system(size: 10, weight: .bold)).tracking(2).foregroundColor(.muted)
      Text(title).font(.system(size: 18, weight: .semibold))
      Button {
        store.choose(role)
      } label: {
        HStack {
          Image(systemName: "doc.badge.plus")
          Text(path.isEmpty ? "选择固件文件" : URL(fileURLWithPath: path).lastPathComponent).lineLimit(2)
            .multilineTextAlignment(.leading)
          Spacer()
          Image(systemName: "chevron.down")
        }.padding(12).frame(maxWidth: .infinity).background(Color.white).overlay(
          RoundedRectangle(cornerRadius: 9).stroke(Color.line))
      }.buttonStyle(.plain)
      content()
      Spacer(minLength: 0)
    }.padding(20).frame(maxWidth: .infinity, minHeight: 250, alignment: .topLeading).background(
      Color.canvas.opacity(0.7)
    ).clipShape(RoundedRectangle(cornerRadius: 12))
  }
  func boardSection(_ number: String, _ title: String, _ rows: [Board], subtitle: String)
    -> some View
  {
    Card {
      VStack(alignment: .leading, spacing: 16) {
        HStack {
          Text(number).foregroundColor(.muted)
          Text(title).font(.system(size: 20, weight: .semibold))
          Spacer()
          Pill(text: "\(rows.count) \(number=="02" ? "台":"条记录")")
        }
        Text(subtitle).font(.system(size: 12)).foregroundColor(.muted)
        HStack {
          Text("ESP32 MAC / 设备").frame(width: 205, alignment: .leading)
          Text("ESP32 进度").frame(maxWidth: .infinity, alignment: .leading)
          Text("ML307H 进度").frame(maxWidth: .infinity, alignment: .leading)
          Text("产测 / 云端").frame(maxWidth: .infinity, alignment: .leading)
          Text("整板结果").frame(width: 92, alignment: .leading)
        }.font(.system(size: 11, weight: .semibold)).foregroundColor(.muted).padding(12).background(
          Color.canvas)
        if rows.isEmpty {
          VStack(spacing: 10) {
            Image(systemName: number == "02" ? "cable.connector" : "tray").font(.system(size: 26))
            Text(number == "02" ? "等待接入设备" : "设备拔出后，记录会显示在这里")
          }.foregroundColor(.muted).frame(maxWidth: .infinity).padding(25)
        } else {
          ForEach(rows) {
            BoardRow(board: $0)
            Divider()
          }
        }
      }
    }
  }
  var about: some View {
    Card {
      VStack(alignment: .leading, spacing: 12) {
        Label("说明与更新", systemImage: "info.circle").font(.system(size: 18, weight: .semibold))
        Text("RingHi · macOS 原生版 \(Disk.version)")
        Text("原生 SwiftUI / AppKit 界面。ESP32 使用乐鑫官方工具，ML307H 自动备份并激活。账号保存在系统钥匙串，CSV 与备份保存到你选择的位置。")
          .foregroundColor(.muted)
        Text("当前原生版通过安装包覆盖更新，保留账号、CSV 和备份；自动更新尚未接入。").font(.system(size: 12)).foregroundColor(
          .muted)
        HStack {
          Button("打开批次记录目录") {
            try? FileManager.default.createDirectory(
              at: Disk.root.appendingPathComponent("batches"), withIntermediateDirectories: true)
            NSWorkspace.shared.open(Disk.root.appendingPathComponent("batches"))
          }
          Button("查看项目发布页") {
            NSWorkspace.shared.open(
              URL(string: "https://github.com/AiSpea/RingHi-flashtool/releases")!)
          }
        }
      }
    }
  }
}
struct BoardRow: View {
  @ObservedObject var board: Board
  @State var details = false
  var body: some View {
    let s = board.state
    HStack(alignment: .top, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        Text(s.mac.isEmpty ? "等待读取 MAC" : s.mac).font(
          .system(size: 12, weight: .semibold, design: .monospaced))
        if !s.imei.isEmpty { Text("IMEI " + s.imei).font(.system(size: 10)) }
        Text("Hub \(s.hub) · \(s.connected ? "已接入":"已拔出")").font(.system(size: 11)).foregroundColor(
          .muted)
      }.frame(width: 193, alignment: .leading)
      chip(s.espProgress, s.espState)
      chip(s.mlProgress, s.mlState)
      VStack(alignment: .leading, spacing: 6) {
        Text(s.production).font(.system(size: 12, weight: .medium))
        Text(s.cloud).font(.system(size: 11)).foregroundColor(.muted)
      }.frame(maxWidth: .infinity, alignment: .leading)
      Button {
        details = true
      } label: {
        VStack(alignment: .leading, spacing: 7) {
          Label(
            s.result,
            systemImage: s.result == "成功"
              ? "checkmark.circle.fill"
              : ["失败", "已中断"].contains(s.result)
                ? "exclamationmark.circle" : "arrow.triangle.2.circlepath"
          ).font(.system(size: 12, weight: .semibold)).foregroundColor(
            s.result == "成功" ? .teal : ["失败", "已中断"].contains(s.result) ? .red : .muted)
          Text("查看详情 ›").font(.system(size: 10)).foregroundColor(.muted)
        }.frame(width: 92, alignment: .leading)
      }.buttonStyle(.plain)
    }.padding(.vertical, 12).padding(.horizontal, 12).sheet(isPresented: $details) {
      BoardDetails(board: board)
    }
  }
  func chip(_ percent: Int, _ state: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("\(percent)%").font(.system(size: 14, weight: .semibold))
      ProgressView(value: Double(percent), total: 100).tint(state.hasPrefix("失败") ? .red : .teal)
      Text(state).font(.system(size: 11)).foregroundColor(state.hasPrefix("失败") ? .red : .muted)
        .lineLimit(5)
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}
struct BoardDetails: View {
  @ObservedObject var board: Board
  @Environment(\.dismiss) var dismiss
  var body: some View {
    let s = board.state
    VStack(alignment: .leading, spacing: 18) {
      Text("设备任务 #\(s.number)").font(.title2.bold())
      Text(s.mac.isEmpty ? "尚未读到 MAC" : s.mac).font(.system(.body, design: .monospaced))
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          detail("ESP32", s.espState)
          detail("ML307H", s.mlState)
          detail("产测", s.production)
          detail("云端", s.cloud)
          detail("整板结果", s.result + " · " + s.reason)
          if !s.backup.isEmpty { detail("备份路径", s.backup) }
          Divider()
          Text("执行时间线（本机时间）").font(.headline)
          ForEach(Array(s.events.enumerated()), id: \.offset) { _, e in
            Text("\(local(e.time))  \(e.chip)  \(e.message)").font(
              .system(size: 12, design: .monospaced))
          }
        }
      }.textSelection(.enabled)
      HStack {
        Button("复制详情") {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(
            "\(s.mac)\nESP32: \(s.espState)\nML307H: \(s.mlState)\n\(s.production)\n\(s.cloud)\n\(s.result): \(s.reason)\n"
              + s.events.map { "\($0.time) \($0.chip) \($0.message)" }.joined(separator: "\n"),
            forType: .string)
        }
        Spacer()
        Button("关闭") { dismiss() }.keyboardShortcut(.defaultAction)
      }
    }.padding(26).frame(width: 620, height: 620)
  }
  func detail(_ name: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(name).font(.caption).foregroundColor(.muted)
      Text(value)
    }
  }
  func local(_ value: String) -> String {
    guard let date = ISO8601DateFormatter.fractional.date(from: value) else { return value }
    let f = DateFormatter()
    f.dateFormat = "HH:mm:ss.SSS"
    return f.string(from: date)
  }
}
struct LoginView: View {
  @ObservedObject var store: Store
  @Environment(\.dismiss) var dismiss
  @State var username = ""
  @State var password = ""
  @State var code = ""
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("ML307H 授权登录").font(.title2.bold())
      Text("沿用官方账号。保存到本机系统钥匙串，不会写入安装包。").foregroundColor(.muted)
      TextField("账号", text: $username)
      SecureField("密码", text: $password)
      SecureField("PC 注册码", text: $code)
      Text(store.notice).font(.caption).foregroundColor(.muted).lineLimit(4)
      HStack {
        Button("取消") { dismiss() }
        Spacer()
        Button(store.loginBusy ? "登录中…" : "登录并保存") { store.login(username, password, code) }
          .buttonStyle(.borderedProminent).tint(.teal).disabled(store.loginBusy)
      }
    }.textFieldStyle(.roundedBorder).padding(28).frame(width: 510).onAppear {
      username = store.spark.username.isEmpty ? "sbcl" : store.spark.username
    }
  }
}
