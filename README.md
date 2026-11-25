# cin·clean for iOS（原生 App，非 PWA）

iPad 上独立运行：**App 内含一个本地网关（127.0.0.1:8790）+ WKWebView**，和安卓 APK 是同一个套路。

```
App 进程
├── Gateway（Network.framework NWListener）
│    ├── /api/home|view|browse|search|related|sorts|fav|img|health
│    ├── 静态：Bundle 内 public/*
│    └── Api → Upstream（URLSession，补 Origin: https://cin.monster）
└── WKWebView → http://127.0.0.1:8790/
```

## 文件结构

```
ios/
├── project.yml                 XcodeGen 配置（生成 .xcodeproj）
├── Sources/
│   ├── App.swift               App 入口 + 网关生命周期
│   ├── ContentView.swift       WKWebView 外壳
│   ├── Gateway.swift           本地 HTTP/1.1 服务（NWListener）
│   ├── Upstream.swift          上游 HTTPS（带 Origin/UA）
│   ├── Api.swift               列表/详情/相关/收藏/图片，对应 server.mjs
│   └── Store.swift             收藏（UserDefaults）+ 图片内存缓存
├── Resources/
│   ├── Info.plist
│   ├── Assets.xcassets/AppIcon.appiconset/icon-1024.png
│   └── public/                 前端（从项目根 public/ 复制，folder reference）
└── .github/workflows/build-ipa.yml   GitHub Actions：macOS runner 编 unsigned IPA
```

## 构建（不需要 Mac）

1. 在 GitHub 建一个仓库，把**整个 `ios/` 目录**推上去（`.github` 也要带上，且要放在仓库根才生效 —— 见下）
2. Actions 里跑 `build-ipa`，从 Artifacts 下载 `CinClean-unsigned.ipa`

> ⚠️ **workflow 必须放在仓库根的 `.github/workflows/`**。如果仓库根就是 `ios/` 的内容，把 `ios/.github` 一起推上去即可；如果仓库根是项目根，把 `ios/.github/workflows/build-ipa.yml` 挪到根目录 `.github/workflows/`，并把 workflow 里的 `working-directory: ios` 改成 `.`。

## 签名安装

unsigned IPA 需要重签才能装：

- **Sideloadly**（Windows）：填 Apple ID，选 IPA，自动签名安装 → **7 天有效**
- **AltStore / SideStore**：7 天自动续签（需要电脑偶尔在线）
- **TrollStore**（iOS 15.6.1 可用）：装一次**永久有效**，需先用漏洞利用装 TrollStore

## 已验证 / 未验证

| 项 | 状态 |
|---|---|
| 前端复用 | ✅ public/ 原样打进 Bundle |
| 网关逻辑 | ✅ 与 Android Gateway.java 同构 |
| 编译 | ⚠️ 本机无 macOS，靠 GitHub Actions 验证 |
| 真机 | ⚠️ 待主人装上后反馈 |

## 和 Android 版的差异

- 没有后台保活：iOS 阅读时 App 在前台，服务就在跑；切后台会被挂起（够用）
- 缓存：图片走内存 LRU + URLCache，列表/详情不落盘（每次现取，本地网关很快）
- 收藏：UserDefaults（安卓是 files/favorites.json）
