import Foundation

/// 上游 HTTPS 取数。
/// 关键点：图床只认 `Origin: https://cin.monster`，这个头必须由原生侧发 —— 浏览器 JS 改不了它。
enum Upstream {
    static let userAgent =
        "Mozilla/5.0 (iPad; CPU OS 15_6 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1"

    struct Result {
        var data: Data
        var status: Int
        var contentType: String
    }

    static func get(host: String,
                    path: String,
                    extraHeaders: [String: String] = [:],
                    timeout: TimeInterval = 20,
                    retries: Int = 2) async throws -> Result {
        var lastError: Error?

        for attempt in 0..<max(1, retries) {
            if attempt > 0 {
                try? await Task.sleep(nanoseconds: UInt64(300 * attempt) * 1_000_000)
            }
            do {
                return try await once(host: host, path: path, extraHeaders: extraHeaders, timeout: timeout)
            } catch {
                lastError = error
            }
        }
        throw lastError ?? URLError(.unknown)
    }

    private static func once(host: String,
                             path: String,
                             extraHeaders: [String: String],
                             timeout: TimeInterval) async throws -> Result {
        guard let url = URL(string: "https://\(host)\(path)") else {
            throw URLError(.badURL)
        }

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = timeout
        req.cachePolicy = .reloadIgnoringLocalCacheData

        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        req.setValue("zh-CN,zh;q=0.9,en;q=0.8", forHTTPHeaderField: "Accept-Language")
        req.setValue("https://cin.monster/", forHTTPHeaderField: "Referer")
        req.setValue("https://cin.monster", forHTTPHeaderField: "Origin")
        req.setValue("gzip, deflate", forHTTPHeaderField: "Accept-Encoding")

        for (k, v) in extraHeaders {
            req.setValue(v, forHTTPHeaderField: k)
        }

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.httpMaximumConnectionsPerHost = 4
        let session = URLSession(configuration: config)

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return Result(data: data,
                      status: http.statusCode,
                      contentType: http.value(forHTTPHeaderField: "Content-Type") ?? "")
    }
}
