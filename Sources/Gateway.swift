import Foundation
import Network

/// 本地 HTTP/1.1 网关（只监听 127.0.0.1）。
/// 对应 Android 版的 Gateway.java：WebView 打开 http://127.0.0.1:PORT/，
/// 页面里所有 /api/* 请求都由这里接管，上游需要的 Origin 头由原生侧发。
final class Gateway {
    private let api: Api
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "cin.gateway", qos: .userInitiated, attributes: .concurrent)
    private(set) var port: UInt16 = 0

    init(api: Api) {
        self.api = api
    }

    // MARK: - 启动

    func start() throws -> UInt16 {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host("127.0.0.1"),
            port: NWEndpoint.Port(integerLiteral: 8790)
        )

        let l: NWListener
        do {
            l = try NWListener(using: params)
        } catch {
            // 端口被占就交给系统分配
            let fallback = NWParameters.tcp
            fallback.requiredLocalEndpoint = NWEndpoint.hostPort(
                host: NWEndpoint.Host("127.0.0.1"),
                port: .any
            )
            l = try NWListener(using: fallback)
        }

        let sem = DispatchSemaphore(value: 0)
        var readyPort: UInt16 = 0

        l.stateUpdateHandler = { state in
            switch state {
            case .ready:
                readyPort = l.port?.rawValue ?? 0
                sem.signal()
            case .failed, .cancelled:
                sem.signal()
            default:
                break
            }
        }
        l.newConnectionHandler = { [weak self] conn in
            self?.accept(conn)
        }
        l.start(queue: queue)

        _ = sem.wait(timeout: .now() + 5)
        guard readyPort != 0 else {
            throw NSError(domain: "cin.gateway", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "本地端口监听失败"])
        }
        listener = l
        port = readyPort
        return readyPort
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    // MARK: - 连接处理

    private func accept(_ conn: NWConnection) {
        conn.stateUpdateHandler = { state in
            if case .failed = state { conn.cancel() }
        }
        conn.start(queue: queue)
        receive(conn, buffer: Data())
    }

    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { conn.cancel(); return }
            if let error = error {
                _ = error
                conn.cancel()
                return
            }
            var acc = buffer
            if let data, !data.isEmpty { acc.append(data) }

            if let req = self.parseRequest(acc) {
                self.dispatch(conn, req)
                return
            }
            if isComplete || acc.count > 1024 * 1024 {
                self.send(conn, status: 400, contentType: "text/plain; charset=utf-8", body: Data("bad request".utf8))
                return
            }
            self.receive(conn, buffer: acc)
        }
    }

    // MARK: - 请求解析

    private struct Request {
        var method: String
        var path: String
        var query: [String: String]
        var headers: [String: String]
        var body: Data
    }

    private func parseRequest(_ data: Data) -> Request? {
        guard let sep = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let headData = data.subdata(in: 0..<sep.lowerBound)
        let bodyStart = sep.upperBound
        guard let headText = String(data: headData, encoding: .utf8) else { return nil }

        var lines = headText.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let requestLine = lines.removeFirst()
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }

        let method = String(parts[0]).uppercased()
        let target = String(parts[1])

        var path = target
        var queryString = ""
        if let q = target.firstIndex(of: "?") {
            path = String(target[..<q])
            queryString = String(target[target.index(after: q)...])
        }

        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let k = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let v = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[k] = v
        }

        let contentLength = Int(headers["content-length"] ?? "0") ?? 0
        let have = data.count - bodyStart
        if have < contentLength { return nil }   // body 还没收全

        let body = contentLength > 0
            ? data.subdata(in: bodyStart..<(bodyStart + contentLength))
            : Data()

        return Request(method: method, path: path, query: parseQuery(queryString), headers: headers, body: body)
    }

    private func parseQuery(_ s: String) -> [String: String] {
        var out: [String: String] = [:]
        guard !s.isEmpty else { return out }
        for pair in s.split(separator: "&") {
            guard let eq = pair.firstIndex(of: "=") else {
                out[decode(String(pair))] = ""
                continue
            }
            let k = decode(String(pair[..<eq]))
            let v = decode(String(pair[pair.index(after: eq)...]))
            out[k] = v
        }
        return out
    }

    private func decode(_ s: String) -> String {
        s.replacingOccurrences(of: "+", with: " ")
            .removingPercentEncoding ?? s
    }

    // MARK: - 路由

    private func dispatch(_ conn: NWConnection, _ req: Request) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let resp = try await self.route(req)
                self.send(conn, status: resp.status, contentType: resp.contentType,
                          body: resp.body, cacheControl: resp.cacheControl)
            } catch {
                let msg = "error: \(error.localizedDescription)"
                self.send(conn, status: 502, contentType: "text/plain; charset=utf-8", body: Data(msg.utf8))
            }
        }
    }

    private struct Response {
        var status: Int = 200
        var contentType: String = "text/plain; charset=utf-8"
        var body: Data = Data()
        var cacheControl: String = "no-store"
    }

    private func route(_ req: Request) async throws -> Response {
        let p = req.path

        switch p {
        case "/api/health":
            let obj: [String: Any] = ["ok": true, "upstream": Api.upHost, "port": port, "native": "ios"]
            return json(200, obj)

        case "/api/home":
            let force = req.query["force"] == "1"
            let data = try await api.home(force: force)
            return json(200, data)

        case "/api/view":
            let data = try await api.view(id: req.query["id"] ?? "")
            return json(200, data)

        case "/api/browse", "/api/search":
            let q = p == "/api/search" ? (req.query["q"] ?? "") : ""
            let page = Int(req.query["page"] ?? "1") ?? 1
            let sort = req.query["sort"] ?? "newest"
            let lang = req.query["lang"] ?? ""
            let force = req.query["force"] == "1"
            let data = try await api.list(q: q, page: page, sort: sort, lang: lang, force: force)
            return json(200, data)

        case "/api/sorts":
            return json(200, [
                "ok": true,
                "sorts": [
                    ["id": "newest", "label": "最新"],
                    ["id": "popular-today", "label": "今日热门"],
                    ["id": "popular-week", "label": "本周"],
                    ["id": "popular-month", "label": "本月"],
                    ["id": "popular-year", "label": "年度"],
                ],
            ])

        case "/api/related":
            let data = try await api.related(id: req.query["id"] ?? "")
            return json(200, data)

        case "/api/fav":
            if req.method == "POST" {
                let body = try JSONSerialization.jsonObject(with: req.body) as? [String: Any] ?? [:]
                return json(200, api.favToggle(body: body))
            }
            return json(200, api.favGet(check: req.query["check"]))

        case "/api/img":
            guard let raw = req.query["u"], !raw.isEmpty else {
                return Response(status: 400, contentType: "text/plain; charset=utf-8", body: Data("missing u".utf8))
            }
            let (data, ct) = try await api.image(urlString: raw)
            return Response(status: 200,
                            contentType: ct,
                            body: data,
                            cacheControl: "public, max-age=604800, immutable")

        default:
            return serveStatic(path: p)
        }
    }

    private func json(_ status: Int, _ obj: Any) -> Response {
        let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{}".utf8)
        return Response(status: status, contentType: "application/json; charset=utf-8", body: data)
    }

    // MARK: - 静态资源（Bundle 里的 public/）

    private func serveStatic(path: String) -> Response {
        var rel = path
        if rel == "/" || rel.isEmpty { rel = "/index.html" }
        if rel.hasPrefix("/assets/") { rel = String(rel.dropFirst("/assets".count)) }

        let name = (rel as NSString).lastPathComponent
        let dir = (rel as NSString).deletingLastPathComponent
        let cleanDir = dir == "/" ? "" : String(dir.dropFirst())

        guard let url = Bundle.main.url(forResource: name,
                                        withExtension: nil,
                                        subdirectory: "public/" + cleanDir) ?? Bundle.main.url(forResource: name, withExtension: nil) else {
            return Response(status: 404, contentType: "text/plain; charset=utf-8", body: Data("not found".utf8))
        }
        guard let data = try? Data(contentsOf: url) else {
            return Response(status: 404, contentType: "text/plain; charset=utf-8", body: Data("not found".utf8))
        }
        return Response(status: 200, contentType: mimeType(for: name), body: data, cacheControl: "no-cache")
    }

    private func mimeType(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }

    // MARK: - 响应写出

    private func send(_ conn: NWConnection,
                      status: Int,
                      contentType: String,
                      body: Data,
                      cacheControl: String = "no-store") {
        var head = "HTTP/1.1 \(status) \(reason(status))\r\n"
        head += "Content-Type: \(contentType)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Cache-Control: \(cacheControl)\r\n"
        head += "Connection: close\r\n"
        head += "X-Content-Type-Options: nosniff\r\n"
        head += "\r\n"

        var out = Data(head.utf8)
        out.append(body)

        conn.send(content: out, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    private func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 500: return "Internal Server Error"
        case 502: return "Bad Gateway"
        default: return "OK"
        }
    }
}
