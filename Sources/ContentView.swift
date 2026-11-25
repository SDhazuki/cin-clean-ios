import SwiftUI
import WebKit

struct ContentView: View {
    @ObservedObject var server: ServerState

    var body: some View {
        Group {
            if server.ready {
                WebView(url: URL(string: "http://127.0.0.1:\(server.port)/")!)
            } else if let err = server.errorText {
                VStack(spacing: 12) {
                    Text("🐟").font(.system(size: 48))
                    Text(err).multilineTextAlignment(.center).padding()
                }
            } else {
                VStack(spacing: 16) {
                    ProgressView()
                    Text("正在启动网关…").foregroundColor(.gray)
                }
            }
        }
        .background(Color(red: 0.03, green: 0.05, blue: 0.07))
        .ignoresSafeArea()
    }
}

struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.isOpaque = false
        w.backgroundColor = UIColor(red: 0.03, green: 0.05, blue: 0.07, alpha: 1)
        w.scrollView.contentInsetAdjustmentBehavior = .never
        w.allowsBackForwardNavigationGestures = true
        w.load(URLRequest(url: url))
        return w
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
