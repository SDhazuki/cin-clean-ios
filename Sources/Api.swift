import Foundation

/// 业务层：把 server.mjs 里 /api/* 的行为在本地重做一遍。
/// 前端 public/app.js 一行不用改，它看到的还是同一套同源 API。
final class Api {
    static let upHost = "cin.monster"
    static let apiHost = "same.yui.pw"
    static let apiBase = "/api/v6"

    private let store: Store

    private let sortsAllowed: Set<String> = [
        "newest", "date", "popular-today", "popular-week", "popular-month", "popular-year",
    ]
    private let langsAllowed: Set<String> = [
        "chinese", "english", "japanese", "korean", "spanish", "portuguese", "french", "german",
    ]
    private let idPattern = try! NSRegularExpression(pattern: "^\\d{1,12}$")
    private let imgHostPattern = try! NSRegularExpression(
        pattern: "(^|\\.)(kontol\\.online|cin\\.monster)$", options: [.caseInsensitive])

    init(store: Store) {
        self.store = store
    }

    // MARK: - 列表 / 搜索

    func list(q: String, page: Int, sort: String, lang: String, force: Bool) async throws -> [String: Any] {
        let safeSort = sortsAllowed.contains(sort) ? sort : "newest"
        let safePage = max(1, min(5000, page))
        let safeLang = langsAllowed.contains(lang) ? lang : ""

        var rawQ = q.trimmingCharacters(in: .whitespacesAndNewlines)
        if rawQ.count > 120 { rawQ = String(rawQ.prefix(120)) }

        let qHasLang = rawQ.lowercased().contains("language:")
        var langFilter = ""
        if !safeLang.isEmpty && !qHasLang {
            langFilter = "language:\"\(safeLang)\""
        }

        var keyword = rawQ
        if !langFilter.isEmpty {
            keyword = keyword.isEmpty ? langFilter : keyword + " " + langFilter
        }
        if keyword.count > 160 { keyword = String(keyword.prefix(160)) }

        let path: String
        if keyword.isEmpty {
            path = "\(Self.apiBase)/search/-/\(safePage)/\(safeSort)"
        } else {
            path = "\(Self.apiBase)/search/\(percentEncode(keyword))/\(safePage)/\(safeSort)"
        }

        let r = try await Upstream.get(host: Self.apiHost, path: path,
                                       extraHeaders: ["Accept": "application/json, text/plain, */*"])
        if r.status == 404 { throw apiError("没有结果") }
        guard (200..<300).contains(r.status) else { throw apiError("API HTTP \(r.status)") }

        guard let json = try? JSONSerialization.jsonObject(with: r.data) as? [String: Any] else {
            throw apiError("API 返回的不是 JSON")
        }

        let rawItems = json["result"] as? [[String: Any]] ?? []
        let items = rawItems.compactMap { normItem($0) }

        return [
            "ok": true,
            "q": rawQ,
            "lang": safeLang,
            "sort": safeSort,
            "page": safePage,
            "totalPages": intValue(json["num_pages"]),
            "perPage": json["per_page"] != nil ? intValue(json["per_page"]) : items.count,
            "items": items,
            "fetchedAt": nowMs(),
        ]
    }

    // MARK: - 首页

    func home(force: Bool) async throws -> [String: Any] {
        let r = try await Upstream.get(host: Self.upHost, path: "/",
                                       extraHeaders: ["Accept": "text/html,application/xhtml+xml"])
        guard (200..<300).contains(r.status) else { throw apiError("首页 HTTP \(r.status)") }
        let html = String(data: r.data, encoding: .utf8) ?? ""
        guard let data = pageData(html) else { throw apiError("首页没有 __NEXT_DATA__") }

        let popular = mapItems(data["popular"] as? [[String: Any]] ?? [])
        let all = mapItems(data["all"] as? [[String: Any]] ?? [])
        if popular.isEmpty && all.isEmpty { throw apiError("首页没解析到作品列表") }

        return [
            "ok": true,
            "popular": popular,
            "all": all,
            "fetchedAt": nowMs(),
        ]
    }

    // MARK: - 详情

    func view(id: String) async throws -> [String: Any] {
        guard isValidId(id) else { throw apiError("作品 id 不合法") }

        let r = try await Upstream.get(host: Self.upHost, path: "/v/\(id)",
                                       extraHeaders: ["Accept": "text/html,application/xhtml+xml"])
        if r.status == 404 { throw apiError("作品不存在或已下架") }
        guard (200..<300).contains(r.status) else { throw apiError("详情 HTTP \(r.status)") }

        let html = String(data: r.data, encoding: .utf8) ?? ""
        guard let d = pageData(html), intValue(d["id"]) != 0 else {
            throw apiError("详情页没有可用数据")
        }

        let images = d["images"] as? [String: Any] ?? [:]
        var pages: [String] = []
        if let rawPages = images["pages"] as? [Any] {
            for p in rawPages {
                if let s = p as? String, !s.isEmpty { pages.append(s) }
                else if let obj = p as? [String: Any], let t = obj["t"] as? String, !t.isEmpty { pages.append(t) }
            }
        }
        if pages.isEmpty { throw apiError("该作品没有可显示的图片") }

        var tags: [[String: Any]] = []
        if let rawTags = d["tags"] as? [Any] {
            for t in rawTags {
                if let s = t as? String {
                    tags.append(["name": s, "type": "tag", "count": 0, "slug": ""])
                } else if let obj = t as? [String: Any] {
                    let name = firstNonEmpty(obj["name"] as? String, obj["title"] as? String, obj["slug"] as? String)
                    if name.isEmpty { continue }
                    tags.append([
                        "name": name,
                        "type": ((obj["type"] as? String) ?? "tag").lowercased(),
                        "count": intValue(obj["count"]),
                        "slug": obj["slug"] as? String ?? "",
                    ])
                }
            }
        }

        let related = mapItems(d["related"] as? [[String: Any]] ?? [])
        let title = d["title"] as? [String: Any]
        let cover = images["cover"] as? [String: Any]

        return [
            "ok": true,
            "id": intValue(d["id"]),
            "title": pickTitle(d["title"]),
            "titleEn": title?["english"] as? String ?? "",
            "titleJp": title?["japanese"] as? String ?? "",
            "lang": d["lang"] as? String ?? "",
            "numPages": d["num_pages"] != nil ? intValue(d["num_pages"]) : pages.count,
            "favorites": intValue(d["num_favorites"]),
            "hits": intValue(d["hits"]),
            "tags": tags,
            "cover": cover?["t"] as? String ?? "",
            "mediaId": d["media_id"] as? String ?? "",
            "pages": pages,
            "related": related,
            "fetchedAt": nowMs(),
        ]
    }

    // MARK: - 相关作品

    func related(id: String) async throws -> [String: Any] {
        guard isValidId(id) else { throw apiError("id 不合法") }

        let r = try await Upstream.get(host: Self.apiHost, path: "\(Self.apiBase)/book/\(id)/related",
                                       extraHeaders: ["Accept": "application/json, text/plain, */*"])
        guard (200..<300).contains(r.status) else { throw apiError("API HTTP \(r.status)") }

        var raw: [[String: Any]] = []
        if let arr = try? JSONSerialization.jsonObject(with: r.data) as? [Any] {
            raw = arr.compactMap { $0 as? [String: Any] }
        } else if let obj = try? JSONSerialization.jsonObject(with: r.data) as? [String: Any] {
            raw = (obj["books"] as? [[String: Any]]) ?? (obj["result"] as? [[String: Any]]) ?? []
        }

        let items = raw.compactMap { normItem($0) }.filter { intValue($0["id"]) != (Int(id) ?? -1) }

        return [
            "ok": true,
            "id": Int(id) ?? 0,
            "items": items,
            "fetchedAt": nowMs(),
        ]
    }

    // MARK: - 收藏

    func favGet(check: String?) -> [String: Any] {
        if let check, !check.isEmpty {
            return ["ok": true, "id": Int(check) ?? 0, "starred": store.isFavorite(id: check)]
        }
        let all = store.favorites()
        let items = all.values.sorted { a, b in
            intValue(a["addedAt"]) > intValue(b["addedAt"])
        }
        return ["ok": true, "count": items.count, "items": items]
    }

    func favToggle(body: [String: Any]) -> [String: Any] {
        let rawId = body["id"]
        let id = rawId is Int ? String(rawId as! Int) : (rawId as? String ?? "")
        guard isValidId(id) else {
            return ["ok": false, "error": "id 不合法"]
        }

        var action = body["action"] as? String ?? "toggle"
        if !["add", "remove", "toggle"].contains(action) { action = "toggle" }

        let has = store.isFavorite(id: id)
        var starred = has

        if action == "add" || (action == "toggle" && !has) {
            var cover = String((body["cover"] as? String ?? "").prefix(600))
            if !cover.lowercased().hasPrefix("https://") { cover = "" }
            let item: [String: Any] = [
                "id": Int(id) ?? 0,
                "title": String((body["title"] as? String ?? "").prefix(300)),
                "titleJp": String((body["titleJp"] as? String ?? "").prefix(300)),
                "cover": cover,
                "pages": intValue(body["pages"]),
                "lang": String((body["lang"] as? String ?? "").prefix(20)),
            ]
            store.addFavorite(id: id, item: item)
            starred = true
        } else {
            store.removeFavorite(id: id)
            starred = false
        }

        return [
            "ok": true,
            "id": Int(id) ?? 0,
            "starred": starred,
            "count": store.favorites().count,
        ]
    }

    // MARK: - 图片代理

    func image(urlString: String) async throws -> (Data, String) {
        guard let url = URL(string: urlString),
              let host = url.host?.lowercased() else {
            throw apiError("bad url")
        }
        guard url.scheme?.lowercased() == "https" else { throw apiError("https only") }
        guard matchesImageHost(host) else { throw apiError("host not allowed") }

        let key = "img:" + host + url.path
        if let hit = store.cachedImage(key) {
            return hit
        }

        var path = url.path
        if let q = url.query, !q.isEmpty { path += "?" + q }

        let r = try await Upstream.get(host: host, path: path,
                                       extraHeaders: ["Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"],
                                       timeout: 25,
                                       retries: 2)
        guard (200..<300).contains(r.status) else { throw apiError("图片 HTTP \(r.status)") }

        let ct = r.contentType.isEmpty ? "image/webp" : r.contentType
        store.cacheImage(key, data: r.data, contentType: ct)
        return (r.data, ct)
    }

    // MARK: - 工具

    private func isValidId(_ id: String) -> Bool {
        let range = NSRange(id.startIndex..., in: id)
        return idPattern.firstMatch(in: id, range: range) != nil
    }

    private func matchesImageHost(_ host: String) -> Bool {
        let range = NSRange(host.startIndex..., in: host)
        return imgHostPattern.firstMatch(in: host, range: range) != nil
    }

    private func nextData(_ html: String) -> [String: Any]? {
        let pattern = "<script id=\"__NEXT_DATA__\"[^>]*>([\\s\\S]*?)</script>"
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(html.startIndex..., in: html)
        guard let m = re.firstMatch(in: html, range: range),
              m.numberOfRanges > 1,
              let r = Range(m.range(at: 1), in: html) else { return nil }
        let json = String(html[r])
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj
    }

    /// props.pageProps.data
    private func pageData(_ html: String) -> [String: Any]? {
        guard let nd = nextData(html),
              let props = nd["props"] as? [String: Any],
              let pp = props["pageProps"] as? [String: Any],
              let data = pp["data"] as? [String: Any] else { return nil }
        return data
    }

    private func pickTitle(_ t: Any?) -> String {
        if let s = t as? String { return s }
        if let d = t as? [String: Any] {
            let pretty = d["pretty"] as? String ?? ""
            if !pretty.isEmpty { return pretty }
            let english = d["english"] as? String ?? ""
            if !english.isEmpty { return english }
            return d["japanese"] as? String ?? ""
        }
        return ""
    }

    private func normItem(_ it: [String: Any]) -> [String: Any]? {
        guard it["id"] != nil else { return nil }
        let title = it["title"] as? [String: Any]
        let cover = it["cover"] as? [String: Any]
        return [
            "id": intValue(it["id"]),
            "title": pickTitle(it["title"]),
            "titleJp": title?["japanese"] as? String ?? "",
            "titleEn": title?["english"] as? String ?? "",
            "lang": it["lang"] as? String ?? "",
            "pages": intValue(it["num_pages"]),
            "cover": cover?["t"] as? String ?? "",
            "w": intValue(cover?["w"]),
            "h": intValue(cover?["h"]),
        ]
    }

    private func mapItems(_ raw: [[String: Any]]) -> [[String: Any]] {
        raw.compactMap { normItem($0) }
    }

    private func firstNonEmpty(_ values: String?...) -> String {
        for v in values {
            if let v, !v.isEmpty { return v }
        }
        return ""
    }

    private func intValue(_ v: Any?) -> Int {
        if let i = v as? Int { return i }
        if let d = v as? Double { return Int(d) }
        if let s = v as? String { return Int(s) ?? 0 }
        return 0
    }

    private func nowMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    /// 与 JS encodeURIComponent 对齐：空格 → %20，而不是 '+'
    private func percentEncode(_ s: String) -> String {
        var out = ""
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        for scalar in s.unicodeScalars {
            if allowed.contains(scalar) {
                out.unicodeScalars.append(scalar)
            } else {
                for byte in String(scalar).utf8 {
                    out += String(format: "%%%02X", byte)
                }
            }
        }
        return out
    }

    private func apiError(_ msg: String) -> NSError {
        NSError(domain: "cin.api", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
    }
}
