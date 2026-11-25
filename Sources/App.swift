import SwiftUI

@main
struct CinCleanApp: App {
    @StateObject private var server = ServerState()

    var body: some Scene {
        WindowGroup {
            ContentView(server: server)
                .onAppear { server.start() }
                .preferredColorScheme(.dark)
        }
    }
}

/// 网关生命周期：App 启动时把本地 HTTP 服务拉起来，WebView 指向它。
final class ServerState: ObservableObject {
    @Published var port: UInt16 = 0
    @Published var ready = false
    @Published var errorText: String?

    private var gateway: Gateway?

    func start() {
        guard gateway == nil else { return }
        // 网关启动会短暂阻塞，别卡主线程
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let store = Store()
            let api = Api(store: store)
            let gw = Gateway(api: api)
            do {
                let p = try gw.start()
                DispatchQueue.main.async {
                    self.gateway = gw
                    self.port = p
                    self.ready = true
                }
            } catch {
                DispatchQueue.main.async {
                    self.errorText = "网关启动失败：\(error.localizedDescription)"
                    print("gateway failed: \(error)")
                }
            }
        }
    }
}
