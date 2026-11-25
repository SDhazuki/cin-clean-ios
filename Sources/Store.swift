import Foundation

/// 收藏落盘（UserDefaults）＋ 图片内存缓存。
final class Store {
    private let defaults = UserDefaults.standard
    private let favKey = "cin.favorites"

    private var imageCache: [String: (Data, String)] = [:]
    private let cacheQueue = DispatchQueue(label: "cin.store.cache")
    private let maxCacheBytes = 64 * 1024 * 1024
    private var cacheBytes = 0

    // MARK: - 收藏

    func favorites() -> [String: [String: Any]] {
        guard let raw = defaults.dictionary(forKey: favKey) else { return [:] }
        var out: [String: [String: Any]] = [:]
        for (k, v) in raw {
            if let item = v as? [String: Any] { out[k] = item }
        }
        return out
    }

    private func save(_ dict: [String: [String: Any]]) {
        defaults.set(dict, forKey: favKey)
    }

    func isFavorite(id: String) -> Bool {
        favorites()[id] != nil
    }

    func addFavorite(id: String, item: [String: Any]) {
        var all = favorites()
        var entry = item
        entry["addedAt"] = Int(Date().timeIntervalSince1970 * 1000)
        all[id] = entry
        save(all)
    }

    func removeFavorite(id: String) {
        var all = favorites()
        all.removeValue(forKey: id)
        save(all)
    }

    // MARK: - 图片缓存

    func cachedImage(_ key: String) -> (Data, String)? {
        cacheQueue.sync { imageCache[key] }
    }

    func cacheImage(_ key: String, data: Data, contentType: String) {
        guard data.count < 8 * 1024 * 1024 else { return }
        cacheQueue.sync {
            if let old = imageCache[key] { cacheBytes -= old.0.count }
            imageCache[key] = (data, contentType)
            cacheBytes += data.count
            if cacheBytes > maxCacheBytes {
                imageCache.removeAll()
                cacheBytes = 0
            }
        }
    }
}
