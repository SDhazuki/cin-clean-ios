/* cin-clean 前端 · 单页
 * 铁律：本页面没有任何外链。所有跳转都是页内 hash 路由，
 *       任何非 # 开头的 <a> 都会被 capture 拦下。
 */
(() => {
  'use strict';

  const app = document.getElementById('app');
  const SORTS = [
    { id: 'date', label: '最新' },
    { id: 'popular-today', label: '今日热门' },
    { id: 'popular-week', label: '本周' },
    { id: 'popular-month', label: '本月' },
    { id: 'popular-year', label: '年度' },
  ];

  const store = {
    view: null,
    favs: new Map(),
    // lang 默认 chinese：中文版是主用途，需要看原文可切「全部」
    list: { q: '', sort: 'date', lang: 'chinese', page: 0, totalPages: 0, seen: new Set(), loading: false, done: false, count: 0 },
    io: null,
  };

  /* ---------------- 横竖屏布局 ----------------
   * 不只用 @media (orientation)：iPad Safari（尤其「添加到主屏幕」后的
   * standalone 模式）转屏时这个媒体查询经常不重算，布局就卡在旧方向。
   * 这里按视口宽高比打 class，resize / orientationchange 都触发，CSS 兜底。
   */
  function syncOrientation() {
    const landscape = window.innerWidth > window.innerHeight * 1.05;
    document.documentElement.classList.toggle('layout-landscape', landscape);
  }
  window.addEventListener('resize', syncOrientation, { passive: true });
  window.addEventListener('orientationchange', () => {
    syncOrientation();
    setTimeout(syncOrientation, 250);   // iOS 转屏后视口尺寸是异步更新的，补一枪
  });
  syncOrientation();

  /* 标题折叠状态：长标题在 sticky 头部会占两行，折叠后只留一行 */
  let titleCollapsed = false;
  try { titleCollapsed = localStorage.getItem('cin-title-collapsed') === '1'; } catch { /* ignore */ }
  function saveTitleCollapsed(v) {
    try { localStorage.setItem('cin-title-collapsed', v ? '1' : '0'); } catch { /* ignore */ }
  }

  async function loadFavs(force) {
    if (!force && store.favs.size) return;
    try {
      const j = await api('/api/fav');
      store.favs = new Map((j.items || []).map(it => [String(it.id), it]));
    } catch { /* 收藏读不到不影响浏览 */ }
  }

  // 标签类型：上游 tags 每条自带 type，搜索时用 type:"值" 精确限定
  const TAG_GROUPS = [
    { type: 'category', label: '类型' },
    { type: 'parody', label: '原作' },
    { type: 'character', label: '角色' },
    { type: 'artist', label: '作者' },
    { type: 'group', label: '社团' },
    { type: 'language', label: '语言' },
    { type: 'tag', label: '标签' },
  ];

  function tagsHTML(tags) {
    if (!tags || !tags.length) return '';
    const list = tags.map(t => (typeof t === 'string' ? { name: t, type: 'tag' } : t)).filter(t => t && t.name);
    const groups = new Map();
    for (const t of list) {
      const ty = String(t.type || 'tag').toLowerCase();
      if (!groups.has(ty)) groups.set(ty, []);
      groups.get(ty).push(t);
    }
    const order = TAG_GROUPS.map(g => g.type);
    const keys = [...groups.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return keys.map(ty => {
      const label = (TAG_GROUPS.find(g => g.type === ty) || {}).label || ty;
      const items = groups.get(ty).map(t =>
        `<button type="button" class="tag" data-tag="${esc(t.name)}" data-tag-type="${esc(ty)}"
          title="${esc(label)}：${esc(t.name)}${t.count ? ' · 约 ' + t.count + ' 部' : ''}">${esc(t.name)}</button>`
      ).join('');
      return `<div class="tag-row"><span class="tag-type">${esc(label)}</span><div class="tag-list">${items}</div></div>`;
    }).join('');
  }

  const LANG = {
    english: { c: '#c78bf3', t: 'EN' },
    chinese: { c: '#a9afe5', t: '中' },
    japanese: { c: '#f0b98b', t: '日' },
    korean: { c: '#8be5c2', t: '韩' },
    spanish: { c: '#8bc7e5', t: 'ES' },
    portuguese: { c: '#e58ba9', t: 'PT' },
    french: { c: '#b7e58b', t: 'FR' },
    german: { c: '#e5d68b', t: 'DE' },
  };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const imgUrl = u => '/api/img?u=' + encodeURIComponent(u);
  const langBadge = l => LANG[l] || { c: '#9aa8bd', t: (l || '?').slice(0, 2).toUpperCase() };

  async function api(path, opts) {
    const timeout = (opts && opts.timeout) || 25000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(path, {
        ...(opts || {}),
        signal: ac.signal,
        headers: { accept: 'application/json', ...((opts && opts.headers) || {}) },
      });
      let j = {};
      try { j = await r.json(); } catch { /* */ }
      if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    } catch (e) {
      // 网关没启动时请求会一直挂着，加超时能直接给提示，不至于"卡死"
      if (e && e.name === 'AbortError') throw new Error('请求超时 —— 检查一下 cin-clean 服务是否还在运行');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- 骨架 ---------------- */
  function buildShell() {
    app.innerHTML = `
      <div class="topbar">
        <a class="brand" href="#/" data-act="home" title="返回主界面"><span class="mark">🐋</span><span class="name">cin<b>·clean</b></span></a>
        <form class="search" id="searchForm" autocomplete="off">
          <input id="q" type="search" placeholder="搜关键词…" spellcheck="false">
          <button type="submit" class="btn search-btn">搜索</button>
        </form>
        <button class="btn" id="favBtn">★ 收藏</button>
        <button class="btn" id="refreshBtn">刷新</button>
        <button class="btn" id="backBtn" style="display:none">← 返回</button>
      </div>
      <div id="main"></div>
      <div id="sentinel" class="sentinel"></div>`;
  }

  const $main = () => document.getElementById('main');
  const $sentinel = () => document.getElementById('sentinel');

  function showTopbar(mode) {
    const back = document.getElementById('backBtn');
    const refresh = document.getElementById('refreshBtn');
    const form = document.getElementById('searchForm');
    const fav = document.getElementById('favBtn');
    const isList = mode === 'list';
    back.style.display = isList ? 'none' : '';
    refresh.style.display = isList || mode === 'fav' ? '' : 'none';
    form.style.display = isList ? '' : 'none';
    fav.style.display = isList ? '' : 'none';
  }

  /* ---------------- 卡片 ---------------- */
  function card(it) {
    const lb = langBadge(it.lang);
    const starred = store.favs.has(String(it.id));
    return `<a class="card" href="#/v/${it.id}">
      <div class="thumb">
        <img data-src="${esc(imgUrl(it.cover))}" alt="" loading="lazy">
        ${it.pages ? `<span class="pages">${it.pages}P</span>` : ''}
        ${it.lang ? `<span class="lang" style="background:${lb.c}">${esc(lb.t)}</span>` : ''}
        ${starred ? `<span class="card-star" title="已收藏">★</span>` : ''}
      </div>
      <div class="meta">
        <div class="t">${esc(it.title)}</div>
        ${it.titleJp && it.titleJp !== it.title ? `<div class="t-jp">${esc(it.titleJp)}</div>` : ''}
      </div>
    </a>`;
  }

  /* 懒加载：图片进入视口附近才真正请求。
   * 原来是一次性给整本 97 张图都设 src，浏览器瞬间排队几十个代理请求，
   * 服务器又对每个请求做多 IP 竞速，上游和本机都被打爆 —— 这是卡死的主因之一。
   */
  let imgIO = null;

  function hydrateImages(root) {
    const scope = root || app;
    const imgs = [...scope.querySelectorAll('img[data-src]')];
    if (!imgs.length) return;

    if (!('IntersectionObserver' in window)) {
      imgs.forEach(img => {
        img.addEventListener('load', () => img.classList.add('on'), { once: true });
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
      });
      return;
    }

    if (!imgIO) {
      imgIO = new IntersectionObserver(entries => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target;
          imgIO.unobserve(img);
          const src = img.dataset.src;
          if (!src) continue;
          img.addEventListener('load', () => img.classList.add('on'), { once: true });
          img.addEventListener('error', () => { img.style.opacity = '0.12'; }, { once: true });
          img.src = src;
          img.removeAttribute('data-src');
        }
      }, { rootMargin: '600px 0px' });   // 提前 600px 加载，滚动时不至于空白
    }
    imgs.forEach(img => imgIO.observe(img));
  }

  /* ---------------- 列表 ---------------- */
  const LANGS = [
    { id: '', label: '全部' },
    { id: 'chinese', label: '中文' },
    { id: 'english', label: 'EN' },
    { id: 'japanese', label: '日' },
  ];

  function resetList(q, sort, lang) {
    store.list = {
      q, sort,
      lang: lang !== undefined ? lang : store.list.lang,
      page: 0, totalPages: 0, seen: new Set(), loading: false, done: false, count: 0,
    };
  }

  function sortsHTML(L) {
    return `<div class="sorts">${SORTS.map(s => `<button class="chip ${L.sort === s.id ? 'on' : ''}" data-sort="${s.id}">${s.label}</button>`).join('')}</div>
      <div class="sorts langs">${LANGS.map(l => `<button class="chip ${L.lang === l.id ? 'on' : ''}" data-lang="${l.id}">${l.label}</button>`).join('')}</div>`;
  }

  function listSkeleton() {
    const cells = Array.from({ length: 12 }, () => `<div class="card skeleton">
      <div class="thumb"></div>
      <div class="meta"><div class="t"></div></div>
    </div>`).join('');
    return `<div class="wrap">
      ${sortsHTML(store.list)}
      <div class="list-info" id="listInfo">正在取列表…</div>
      <div class="grid" id="grid">${cells}</div>
    </div>`;
  }

  function listFrame() {
    return `<div class="wrap">
      ${sortsHTML(store.list)}
      <div class="list-info" id="listInfo"></div>
      <div class="grid" id="grid"></div>
      <div class="list-foot" id="listFoot"></div>
    </div>`;
  }

  function updateInfo() {
    const L = store.list;
    const el = document.getElementById('listInfo');
    if (!el) return;
    const head = L.q ? `「${esc(L.q)}」` : SORTS.find(s => s.id === L.sort)?.label || '';
    const total = L.totalPages ? ` · 约 ${L.totalPages} 页` : '';
    el.innerHTML = `${head} <span class="dim">${L.count} 部${total}</span>`;
  }

  function updateFoot(msg) {
    const el = document.getElementById('listFoot');
    if (!el) return;
    if (msg) { el.innerHTML = msg; return; }
    const L = store.list;
    if (L.loading) el.innerHTML = `<div class="spin sm"></div>`;
    else if (L.done) el.innerHTML = `<span class="dim">已经到底了 · 共 ${L.count} 部</span>`;
    else el.innerHTML = `<button class="btn primary" data-act="more">加载更多</button>`;
  }

  async function loadMore(reset) {
    const L = store.list;
    if (L.loading) return;
    if (reset && L.page > 0) return;      // 重置时只允许一次
    if (!reset && L.done) return;

    L.loading = true;
    updateFoot();

    try {
      const next = reset ? 1 : L.page + 1;
      const params = new URLSearchParams({ page: String(next), sort: L.sort });
      if (L.q) params.set('q', L.q);
      if (L.lang) params.set('lang', L.lang);
      const ep = L.q ? `/api/search?${params}` : `/api/browse?${params}`;
      const j = await api(ep);

      L.page = next;
      L.totalPages = j.totalPages || L.totalPages;

      const items = (j.items || []).filter(it => !L.seen.has(it.id));
      items.forEach(it => L.seen.add(it.id));
      L.count += items.length;

      const grid = document.getElementById('grid');
      if (grid) {
        if (reset) grid.innerHTML = '';
        const html = items.map(card).join('');
        grid.insertAdjacentHTML('beforeend', html);
        hydrateImages(grid);
      }
      if (!items.length) L.done = true;
      updateInfo();
      updateFoot();
    } catch (e) {
      L.loading = false;
      updateFoot(`<span class="err">取列表失败：${esc(e.message)}</span> <button class="btn" data-act="more">重试</button>`);
      return;
    }
    L.loading = false;
    updateFoot();
    if (!L.done && $sentinel()) observeSentinel();
  }

  /* 无限滚动 */
  function observeSentinel() {
    if (store.io) store.io.disconnect();
    const el = $sentinel();
    if (!el) return;
    store.io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        const route = currentRoute();
        if (route.name === 'list' && !store.list.loading && !store.list.done) loadMore(false);
      }
    }, { rootMargin: '800px 0px' });
    store.io.observe(el);
  }

  /* ---------------- 渲染令牌 ----------------
   * 异步渲染的坑：await 期间用户可能已经切页（点返回、按 Esc、点另一部作品），
   * 迟到的响应会把新页面整个覆盖掉 —— 现象就是「按了返回但还停在阅读器，刷新才对」。
   * 每次渲染领一个号，await 回来对不上号就直接放弃写 DOM。
   */
  let renderSeq = 0;

  async function renderList(opts = {}) {
    const seq = ++renderSeq;
    const q = opts.q !== undefined ? opts.q : store.list.q;
    const sort = opts.sort || store.list.sort;
    const lang = opts.lang !== undefined ? opts.lang : store.list.lang;
    // 额外一条：DOM 里没有 grid 说明现在停在阅读器 / 收藏页，
    // 这时哪怕查询条件没变也必须重建，否则「返回」只会换个顶栏、内容还是旧页面。
    // 收藏页也有 #grid，用 data-fav 把它排除掉。
    const gridEl = document.getElementById('grid');
    const hasGrid = !!gridEl && !gridEl.dataset.fav;
    if (opts.reload || q !== store.list.q || sort !== store.list.sort || lang !== store.list.lang
        || store.list.page === 0 || !hasGrid) {
      resetList(q, sort, lang);
      showTopbar('list');
      $main().innerHTML = listSkeleton();
      await loadMore(true);
      if (seq !== renderSeq) return;      // 等待期间已经切走了
      observeSentinel();
    } else {
      showTopbar('list');
    }
  }

  /* ---------------- 阅读器 ---------------- */
  async function renderReader(id) {
    const seq = ++renderSeq;
    showTopbar('reader');
    $main().innerHTML = `<div class="wrap"><div class="state"><div class="spin"></div><p>正在取作品信息…</p></div></div>`;
    if (store.io) store.io.disconnect();

    try {
      await loadFavs();
      if (seq !== renderSeq) return;
      if (!store.view || store.view.id !== Number(id)) {
        store.view = await api('/api/view?id=' + encodeURIComponent(id));
      }
      // 关键守卫：请求回来时用户可能已经点返回 / 进了别的作品，别把新页面盖掉
      if (seq !== renderSeq) return;
      const v = store.view;
      const lb = langBadge(v.lang);

      const tagTotal = (v.tags || []).length;
      const starred = store.favs.has(String(v.id));
      const mode = readMode();
      const cover = v.cover || v.pages[0] || '';

      // 详情页 = 信息卡：竖屏时标签通栏，横屏时回到「封面左 / 信息右」的横向布局
      $main().innerHTML = `
        <div class="detail-wrap">
          <button class="detail-cover" data-act="fs-enter" title="开始阅读">
            <img src="${esc(imgUrl(cover))}" alt="${esc(v.title || ('作品 ' + v.id))}">
          </button>

          <div class="detail-head">
            <h1 class="detail-title" title="${esc(v.title || '')}">${esc(v.title || ('作品 ' + v.id))}</h1>
            <div class="detail-meta">
              <span class="chip" style="border-color:${lb.c}66;color:${lb.c}">${esc(lb.t)}</span>
              <span class="chip">${v.numPages} 页</span>
              ${v.favorites ? `<span class="chip">♥ ${v.favorites}</span>` : ''}
              <button class="btn star ${starred ? 'on' : ''}"
                data-act="fav-toggle" data-id="${v.id}">${starred ? '★ 已收藏' : '☆ 收藏'}</button>
            </div>
          </div>

          <div class="tags-bar detail-tags">
            ${tagTotal ? `<div class="tags" id="tagsBox">${tagsHTML(v.tags)}</div>` : ''}
            ${tagTotal > 12 ? `<button class="tags-toggle" data-act="toggle-tags" data-label="展开全部 ${tagTotal} 个标签 ▾">收起标签 ▴</button>` : ''}
            <div id="relatedRow" class="tag-row related-row" style="display:none"></div>
          </div>

          <div class="detail-actions">
            <button class="btn primary big" data-act="fs-enter" title="开始阅读（F）">▶ 开始阅读</button>
            <span class="rel-wrap">
              <button class="btn rel-btn" data-act="rel-toggle" title="相关作品（同一本的其他语言版本）">相关 ▾</button>
              <div class="rel-pop" id="relPop"></div>
            </span>
          </div>

          <div class="detail-foot">
            <div class="mode-switch" role="group" aria-label="阅读模式">
              <button class="mode-opt${mode === 'flip' ? ' on' : ''}" data-act="mode-flip" title="全屏逐页翻">↔ 翻页</button>
              <button class="mode-opt${mode === 'scroll' ? ' on' : ''}" data-act="mode-scroll" title="竖向连续滚动">↕ 滚动</button>
            </div>
            <span class="dim small">${v.numPages} 页 · 阅读时双指同触 / 鼠标中键唤出工具栏</span>
          </div>
        </div>`;

      window.scrollTo(0, 0);
      renderVersionRow();   // 版本查询入口（本地算，不请求接口）
    } catch (e) {
      if (seq !== renderSeq) return;
      $main().innerHTML = `<div class="wrap"><div class="state">
        <div class="big">🐟</div><h3>作品打不开</h3><p>${esc(e.message)}</p>
        <button class="btn primary" data-act="retry-view">重试</button>
      </div></div>`;
    }
  }

  /* ---------------- 相关作品 ---------------- */
  const shortTitle = (s, n = 26) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  /** 从标题里剥掉 [社团] (展会) {标记} 之类，留核心词用于模糊搜索 */
  function titleKeyword(title) {
    const t = String(title || '')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/[｜|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return '';
    const words = t.split(' ').filter(w => w.length > 1);
    // 日文没有空格，词数少时整段带上；英文取前 8 个词
    return words.slice(0, 8).join(' ').slice(0, 80);
  }

  /**
   * 找同一作品的其他语言版本用「作者 + 系列号」最准：
   * 标题会被翻译成不同语言，但作者名和系列号（第几部）是共通的。
   * 实测 artist:"kurukuru" 4 能同时命中日文原版和英文版。
   */
  function versionsQuery() {
    const v = store.view;
    if (!v) return '';
    const artist = (v.tags || []).find(t => String(t.type || '').toLowerCase() === 'artist');
    const nums = String(v.title || '').match(/\d{1,3}/g);
    const num = nums ? nums[nums.length - 1] : '';
    if (artist) return `artist:"${artist.name}"${num ? ' ' + num : ''}`;
    return titleKeyword(v.title);
  }

  /** 版本查询：只留「中文版 / 全部版本」两个入口，不再列相关作品。
   *  纯本地计算（作者名 + 系列号），不用请求 /api/related。
   */
  function renderVersionRow() {
    const row = document.getElementById('relatedRow');
    if (!row) return;
    const v = store.view;
    const artist = (v?.tags || []).find(t => String(t.type || '').toLowerCase() === 'artist');
    const qAll = versionsQuery();
    const qZh = artist ? `artist:"${artist.name}" language:"chinese"` : '';
    if (!qAll && !qZh) return;

    row.style.display = '';
    row.innerHTML = `<span class="tag-type">版本</span>
      <div class="tag-list">
        ${qZh ? `<button type="button" class="tag rel-zh" data-act="rel-zh"
          title="列出该作者的全部中文作品（含同系列其他部）">⌕ 中文版</button>` : ''}
        ${qAll ? `<button type="button" class="tag rel-search" data-act="rel-search"
          title="按「作者 + 系列号」搜索：${esc(qAll)}">⌕ 全部版本</button>` : ''}
      </div>`;
  }

  /* ---------------- 收藏夹 ---------------- */
  async function renderFav() {
    const seq = ++renderSeq;
    showTopbar('fav');
    if (store.io) store.io.disconnect();
    $main().innerHTML = `<div class="wrap"><div class="state"><div class="spin"></div><p>读取收藏…</p></div></div>`;
    try {
      await loadFavs(true);
      if (seq !== renderSeq) return;
      const items = [...store.favs.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      if (!items.length) {
        $main().innerHTML = `<div class="wrap"><div class="state">
          <div class="big">☆</div>
          <h3>还没有收藏</h3>
          <p>打开任一本作品，点标题下方的「☆ 收藏」，它就会出现在这里。</p>
          <a class="btn primary" href="#/">去逛逛</a>
        </div></div>`;
        return;
      }
      const grid = items.map(it => card({
        id: it.id,
        title: it.title,
        titleJp: it.titleJp,
        cover: it.cover,
        pages: it.pages,
        lang: it.lang,
      })).join('');
      $main().innerHTML = `<div class="wrap">
        <div class="list-info">我的收藏 <span class="dim">${items.length} 部</span></div>
        <div class="grid" id="grid" data-fav="1">${grid}</div>
      </div>`;
      hydrateImages($main());
    } catch (e) {
      if (seq !== renderSeq) return;
      $main().innerHTML = `<div class="wrap"><div class="state">
        <div class="big">🐟</div><h3>收藏读不出来</h3><p>${esc(e.message)}</p>
        <button class="btn primary" data-act="retry-fav">重试</button>
      </div></div>`;
    }
  }

  /* ---------------- 阅读模式 ----------------
   * flip = 全屏逐页翻（日漫从右往左）
   * scroll = 竖向连续滚动
   * 存 localStorage，详情页和阅读器工具栏都能切。
   */
  const MODE_KEY = 'cin-mode';
  function readMode() {
    try { return localStorage.getItem(MODE_KEY) === 'scroll' ? 'scroll' : 'flip'; } catch { return 'flip'; }
  }
  function saveMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode === 'scroll' ? 'scroll' : 'flip'); } catch { /* ignore */ }
  }

  /* ---------------- 全屏阅读（日漫：从右往左） ----------------
   * 单页/双页由屏幕方向决定；双页时 DOM 顺序是 [前页, 后页]，
   * 靠 CSS flex-direction: row-reverse 把后页摆到左边、前页摆在右边。
   * scroll 模式下改成整条竖向长图，共用同一个覆盖层与工具栏。
   */
  const FS = { open: false, idx: 0, spread: false, el: null, hideTimer: null, rtl: true, mode: 'flip' };

  function readRtl() {
    try { return localStorage.getItem('cin-rtl') !== '0'; } catch { return true; }
  }
  function saveRtl(v) {
    try { localStorage.setItem('cin-rtl', v ? '1' : '0'); } catch { /* ignore */ }
  }
  FS.rtl = readRtl();
  let fsSuppressClick = 0;

  const fsSpreadNow = () => window.innerWidth > window.innerHeight * 1.16;

  function fsEnsureEl() {
    if (FS.el) return FS.el;
    const el = document.createElement('div');
    el.className = 'fs';
    el.innerHTML = `
      <div class="fs-progress"><i id="fsProg"></i></div>
      <div class="fs-stage" id="fsStage"></div>
      <div class="fs-scroll" id="fsScroll"></div>
      <div class="fs-corner-num dim" id="fsNum"></div>
      <div class="fs-jump" id="fsJump">
        <div class="fs-jump-head">
          <span>跳转</span>
          <button class="fs-btn tiny" data-act="fs-jump-toggle" title="收起">✕</button>
        </div>
        <div class="fs-jump-grid" id="fsJumpGrid"></div>
      </div>
      <div class="fs-bar" id="fsBar">
        <button class="fs-btn" data-act="fs-prev" title="上一页">‹</button>
        <button class="fs-btn" data-act="fs-next" title="下一页">›</button>
        <button class="fs-btn" data-act="fs-jump-toggle" title="跳转（缩略图）">⊞</button>
        <button class="fs-btn wide" data-act="fs-mode" id="fsMode" title="切换阅读模式：翻页 / 滚动">↔ 翻页</button>
        <button class="fs-btn wide" data-act="fs-rtl" id="fsRtl" title="切换阅读方向：日漫从右往左 / 从左往右">RTL</button>
        <button class="fs-btn" data-act="fs-close" title="退出阅读（Esc）｜双指同触 / 鼠标中键 显隐此栏">✕</button>
      </div>`;
    document.body.appendChild(el);
    FS.el = el;
    // 不再跟随鼠标移动自动出现：工具栏只在双指同触 / 鼠标中键时唤出
    el.addEventListener('wheel', fsWheel, { passive: false });
    // 用 Pointer Events 统一鼠标 / 触摸：iPad 上是手指滑动，桌面上也能按住拖拽翻页
    el.addEventListener('pointerdown', fsPointerDown);
    el.addEventListener('pointerup', fsPointerUp);
    el.addEventListener('pointercancel', () => { fsPointer = null; });
    // 双指同触（iPad）切换底部工具栏
    el.addEventListener('touchstart', fsTouchStart, { passive: false });
    // 鼠标中键（电脑）切换底部工具栏
    el.addEventListener('mousedown', fsMouseDown);
    el.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    // 跳转面板滚动时按位置补图
    const jg = el.querySelector('#fsJumpGrid');
    if (jg) jg.addEventListener('scroll', fsJumpOnScroll, { passive: true });
    // 滚动模式：按滚动位置更新页码
    const sc = el.querySelector('#fsScroll');
    if (sc) sc.addEventListener('scroll', fsScrollOnScroll, { passive: true });
    return el;
  }

  /* 阅读器「相关」下拉：同作品的不同语言版本 */
  async function relFill() {
    const pop = document.getElementById('relPop');
    if (!pop) return;
    const v = store.view;
    if (!v) return;
    if (pop.dataset.loaded === String(v.id)) return;   // 同一本只拉一次
    pop.innerHTML = '<div class="fs-rel-tip">读取中…</div>';
    try {
      const j = await api('/api/related?id=' + encodeURIComponent(v.id));
      const items = (j.items || []).slice(0, 12)
        .sort((a, b) => (String(a.lang).toLowerCase() === 'chinese' ? 0 : 1) - (String(b.lang).toLowerCase() === 'chinese' ? 0 : 1));
      if (!items.length) { pop.innerHTML = '<div class="fs-rel-tip">没有相关作品</div>'; return; }
      pop.dataset.loaded = String(v.id);
      pop.innerHTML = items.map(it => `
        <button class="fs-rel-item" data-fs-rel-id="${it.id}" title="${esc(it.title)}">
          <span class="fs-rel-thumb"><img src="${esc(imgUrl(it.cover))}" alt="" loading="lazy"></span>
          <span class="fs-rel-lang">${esc(langBadge(it.lang).t)}</span>
          <span class="fs-rel-title">${esc(shortTitle(it.title, 46))}</span>
        </button>`).join('');
    } catch {
      pop.innerHTML = '<div class="fs-rel-tip">读取失败</div>';
    }
  }

  function relToggle(force) {
    const pop = document.getElementById('relPop');
    if (!pop) return;
    const open = force !== undefined ? force : !pop.classList.contains('open');
    pop.classList.toggle('open', open);
    if (open) relFill();
  }
  let fsLastBarToggle = 0;

  function fsToggleBar(show) {
    const bar = FS.el && FS.el.querySelector('#fsBar');
    if (!bar) return;
    const now = Date.now();
    // 手动切换去重：iPad 上一次双指会同时触发 touchstart 和 pointerdown，
    // 不去重就开关两次互相抵消，表现成「双指没反应」
    if (show === undefined) {
      if (now - fsLastBarToggle < 600) return;
      fsLastBarToggle = now;
    }
    clearTimeout(FS.hideTimer);
    const wantShow = show !== undefined ? show : bar.classList.contains('hide');
    if (wantShow) {
      bar.classList.remove('hide');
      fsScheduleHide();          // 显示后仍然自动淡出
    } else {
      bar.classList.add('hide');
    }
  }

  let fsMultiUntil = 0;
  let fsPointersTouch = 0;
  const fsPointers = new Map();   // 当前按下的指针，用来识别双指同触

  /* ---------------- 全屏跳转：右侧缩略图列 ---------------- */

  function fsJumpClose() {
    const box = FS.el && FS.el.querySelector('#fsJump');
    if (!box) return;
    box.classList.remove('open');
    box.querySelectorAll('img').forEach(im => {
      if (im.dataset.src) return;                    // 还没加载的保持原样
      im.removeAttribute('src');                     // 放掉解码内存
      if (im.dataset.url) im.setAttribute('data-src', im.dataset.url);   // 重新标记为待加载
    });
  }

  function fsJumpBuild() {
    const grid = FS.el && FS.el.querySelector('#fsJumpGrid');
    const v = store.view;
    if (!grid || !v) return;
    if (grid.dataset.for === String(v.id)) return;   // 同一本只构建一次

    const n = v.pages.length;
    grid.dataset.for = String(v.id);
    grid.innerHTML = Array.from({ length: n }, (_, i) =>
      `<button class="fs-jump-item${i === FS.idx ? ' cur' : ''}" data-jump-i="${i}">
        <img data-url="${esc(imgUrl(v.pages[i]))}" data-src="${esc(imgUrl(v.pages[i]))}" alt="" loading="lazy">
        <span class="fs-jump-no">${i + 1}</span>
      </button>`
    ).join('');
  }

  /* 缩略图生成：上游没有小图接口（?w= / ?q= 之类全被忽略，永远返回原图），
   * 但图片都走同源代理，canvas 不会被跨域污染，可以直接缩小。
   * 生成后把 img.src 换成 dataURL，浏览器随即释放原图的解码内存。
   */
  const THUMB_W = 180;
  const thumbCache = new Map();     // url -> dataURL
  let thumbBusy = 0;
  const thumbQueue = [];
  const THUMB_PARALLEL = 2;         // 同时最多解码 2 张大图，压住内存峰值

  function genThumb(url) {
    if (thumbCache.has(url)) return Promise.resolve(thumbCache.get(url));
    return new Promise(resolve => {
      thumbQueue.push({ url, resolve });
      pumpThumb();
    });
  }

  function pumpThumb() {
    while (thumbBusy < THUMB_PARALLEL && thumbQueue.length) {
      const job = thumbQueue.shift();
      if (thumbCache.has(job.url)) { job.resolve(thumbCache.get(job.url)); continue; }
      thumbBusy++;
      const img = new Image();
      img.decoding = 'async';
      const done = val => { thumbBusy--; job.resolve(val); pumpThumb(); };
      img.onload = () => {
        try {
          const w = Math.min(THUMB_W, img.naturalWidth);
          const h = Math.max(1, Math.round(img.naturalHeight * (w / img.naturalWidth)));
          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          const data = cv.toDataURL('image/webp', 0.72);
          if (thumbCache.size > 800) thumbCache.clear();   // 简单上限，别无限增长
          thumbCache.set(job.url, data);
          done(data);
        } catch {
          done(null);   // 缩不了就退回原图
        }
      };
      img.onerror = () => done(null);
      img.src = job.url;
    }
  }

  /** 按滚动位置手动填充缩略图。
   *  不用 IntersectionObserver —— 面板内元素尺寸靠 padding 撑出来，
   *  各家浏览器对「absolute 子元素 + 滚动祖先」的判定不一致，
   *  直接算 offsetTop 并加硬上限，内存完全可控。
   */
  function fsJumpFill() {
    const grid = FS.el && FS.el.querySelector('#fsJumpGrid');
    if (!grid) return;
    const items = grid.querySelectorAll('.fs-jump-item');
    if (!items.length) return;
    const pad = 300;
    const top = grid.scrollTop - pad;
    const bottom = grid.scrollTop + grid.clientHeight + pad;
    let used = 0;
    for (const it of items) {
      if (used >= 12) break;                       // 一次性最多处理 12 张
      if (it.offsetTop > bottom) break;
      if (it.offsetTop + it.offsetHeight < top) continue;
      const img = it.querySelector('img[data-src]');
      if (!img) continue;
      const src = img.dataset.url || img.dataset.src;
      img.removeAttribute('data-src');
      used++;
      // 有缓存直接用小图；没有就排队生成（内部限流 2 张并发）
      genThumb(src).then(t => { img.src = t || src; });
    }
  }

  let fsJumpScrollTimer = 0;
  function fsJumpOnScroll() {
    clearTimeout(fsJumpScrollTimer);
    fsJumpScrollTimer = setTimeout(fsJumpFill, 120);   // 滚动节流
  }

  function fsJumpOpen() {
    const box = FS.el && FS.el.querySelector('#fsJump');
    if (!box) return;
    box.classList.add('open');       // 先展开，宽度过渡开始
    fsJumpBuild();                   // 再构建 DOM
    clearTimeout(FS.jumpObsTimer);
    // 等宽度过渡（240ms）结束、布局稳定后再按位置填充
    FS.jumpObsTimer = setTimeout(() => {
      const cur = box.querySelector('.fs-jump-item.cur') || box.querySelector('.fs-jump-item');
      if (cur) { try { cur.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch { /* */ } }
      fsJumpFill();
    }, 300);
  }

  function fsJumpToggle() {
    const box = FS.el && FS.el.querySelector('#fsJump');
    if (!box) return;
    if (box.classList.contains('open')) fsJumpClose();
    else fsJumpOpen();
    fsScheduleHide();
  }

  function fsGoto(idx) {
    const v = store.view;
    if (!v) return;
    const n = v.pages.length;
    let i = Math.max(0, Math.min(Number(idx) || 0, n - 1));
    if (FS.spread && i % 2 === 1) i -= 1;
    if (i === FS.idx) { fsJumpClose(); return; }
    const dir = i >= FS.idx ? 1 : -1;
    FS.idx = i;
    fsSlide(i, dir);
    fsJumpClose();
  }
  function fsDirFromLeft(leftSide) {
    return FS.rtl ? (leftSide ? 1 : -1) : (leftSide ? -1 : 1);
  }

  function fsSyncRtlUi() {
    const stage = FS.el && FS.el.querySelector('#fsStage');
    if (stage) {
      stage.classList.toggle('rtl', !!FS.rtl);
      stage.classList.toggle('ltr', !FS.rtl);
    }
    const b = FS.el && FS.el.querySelector('#fsRtl');
    if (b) {
      b.textContent = FS.rtl ? 'RTL' : 'LTR';
      b.classList.toggle('on', !!FS.rtl);
      b.title = FS.rtl
        ? '当前：日漫 从右往左（点左侧=下一页）。点击切换为从左往右'
        : '当前：从左往右（点左侧=上一页）。点击切换为日漫从右往左';
    }
  }

  function fsToggleRtl() {
    FS.rtl = !FS.rtl;
    saveRtl(FS.rtl);
    fsSyncRtlUi();
    fsScheduleHide();
  }

  function fsTouchStart(e) {
    if (!FS.open) return;
    // 部分环境（含合成事件）touches 会是空数组，用 changedTouches 兜底
    const n = (e.touches && e.touches.length) || (e.changedTouches && e.changedTouches.length) || 0;
    if (n >= 2) {
      e.preventDefault();
      fsMultiUntil = Date.now() + 500;   // 双指手势期间不翻页
      fsPointer = null;
      fsToggleBar();
    }
  }

  function fsMouseDown(e) {
    if (!FS.open) return;
    if (e.button === 1) {                // 中键
      e.preventDefault();
      fsToggleBar();
    }
  }

  /* 左右滑动翻页（iPad 没有滚轮，这是主力操作）
   * 用 Pointer Events：pointerType 同时覆盖 touch 和 mouse，兼容性好且可测。
   */
  let fsPointer = null;

  function fsPointerDown(e) {
    if (!FS.open) return;
    if (e.pointerType === 'mouse' && e.button === 1) {   // 中键 → 显隐工具栏
      e.preventDefault();
      fsToggleBar();
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const now = Date.now();
    // 万一有指针没清干净（被系统手势打断等），2 秒后自动重置，否则单指会被误判成双指
    if (fsPointers.size && now - fsPointersTouch > 2000) fsPointers.clear();
    fsPointersTouch = now;

    fsPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fsPointers.size >= 2) {                          // 双指同触 → 显隐工具栏
      fsMultiUntil = now + 500;
      fsPointer = null;
      fsToggleBar();
      return;
    }
    if (e.isPrimary === false) { fsPointer = null; return; }
    fsPointer = { x: e.clientX, y: e.clientY, t: now, id: e.pointerId };
  }

  function fsPointerUp(e) {
    fsPointers.delete(e.pointerId);
    fsPointersTouch = Date.now();
    const start = fsPointer;
    fsPointer = null;
    if (!FS.open || !start) return;
    if (FS.mode === 'scroll') return;                          // 滚动模式不翻页
    if (Date.now() < fsMultiUntil) return;                     // 双指手势期间，忽略滑动
    if (start.id !== undefined && e.pointerId !== undefined && e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = Date.now() - start.t;
    // 主判据是位移；时间只用来排除"按住很久再拖"的误触，阈值放宽
    // （页面正加载大图时主线程繁忙，40ms 的间隔也可能被拖到 1s 以上）
    if (dt > 1500) return;
    if (Math.abs(dx) < 30) return;               // 位移太小不算（当作点击）
    if (Math.abs(dy) > Math.abs(dx)) return;     // 竖向手势忽略
    fsSuppressClick = Date.now() + 350;          // 抑制滑动后紧跟的 click，避免翻两次
    fsMove(fsDirFromLeft(dx > 0));               // 向右滑 = 左侧方向（方向按主人手感反转）
  }

  /* 滚轮翻页：向下 = 下一页，向上 = 上一页（日漫往左翻） */
  let fsWheelAcc = 0;
  let fsWheelLock = 0;

  function fsWheel(e) {
    if (!FS.open) return;
    if (FS.mode === 'scroll') return;      // 滚动模式：交还给容器自然滚动
    e.preventDefault();
    const now = Date.now();
    if (now < fsWheelLock) return;
    // deltaMode: 0=像素 1=行 2=页，统一折算成像素
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
    fsWheelAcc += e.deltaY * unit;
    if (Math.abs(fsWheelAcc) < 50) return;       // 触控板小幅滑动先累积
    const dir = fsWheelAcc > 0 ? 1 : -1;
    fsWheelAcc = 0;
    fsWheelLock = now + 200;                      // 一次滚轮手势只翻一屏
    fsMove(dir);
  }

  function fsScheduleHide() {
    const bar = FS.el && FS.el.querySelector('#fsBar');
    if (!bar) return;
    bar.classList.remove('hide');
    clearTimeout(FS.hideTimer);
    FS.hideTimer = setTimeout(() => bar.classList.add('hide'), 2600);
  }

  function fsUpdateNum(ids, n) {
    const num = FS.el && FS.el.querySelector('#fsNum');
    if (num) {
      const a = ids[0] + 1, b = ids[ids.length - 1] + 1;
      num.textContent = a === b ? `${a} / ${n}` : `${a}-${b} / ${n}`;
      // 翻页时短暂点亮，平时保持半透明不抢戏
      num.classList.remove('dim');
      clearTimeout(FS.numTimer);
      FS.numTimer = setTimeout(() => num.classList.add('dim'), 1300);
    }
    // 顶部进度条
    const prog = FS.el && FS.el.querySelector('#fsProg');
    if (prog) {
      const shown = ids[ids.length - 1] + 1;
      prog.style.width = Math.min(100, Math.max(0, (shown / n) * 100)).toFixed(2) + '%';
    }
    // 跳转面板当前页高亮
    const grid = FS.el && FS.el.querySelector('#fsJumpGrid');
    if (grid && grid.dataset.for) {
      grid.querySelectorAll('.fs-jump-item.cur').forEach(el => el.classList.remove('cur'));
      const cur = grid.querySelector(`.fs-jump-item[data-jump-i="${ids[0]}"]`);
      if (cur) cur.classList.add('cur');
    }
  }

  /* 预取后面两页（够一个翻页周期），放到空闲时做，别跟当前页抢带宽 */
  function fsPrefetch(ids, n) {
    const v = store.view;
    if (!v) return;
    const run = () => {
      for (let k = 1; k <= 2; k++) {
        const i = ids[ids.length - 1] + k;
        if (i < n) { const im = new Image(); im.src = imgUrl(v.pages[i]); }
      }
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1200 });
    else setTimeout(run, 150);
  }

  /* ---------------- 滚动模式 ---------------- */

  function fsSyncModeUi() {
    if (!FS.el) return;
    const b = FS.el.querySelector('#fsMode');
    if (b) {
      const scroll = FS.mode === 'scroll';
      b.textContent = scroll ? '↕ 滚动' : '↔ 翻页';
      b.classList.toggle('on', scroll);
      b.title = scroll ? '当前：竖向滚动。点击切到翻页' : '当前：逐页翻。点击切到滚动';
    }
    FS.el.classList.toggle('mode-scroll', FS.mode === 'scroll');
  }

  function fsScrollRender(force) {
    const v = store.view;
    if (!v || !FS.el) return;
    const box = FS.el.querySelector('#fsScroll');
    if (!box) return;
    const n = v.pages.length;

    if (force || box.dataset.for !== String(v.id)) {
      box.dataset.for = String(v.id);
      box.innerHTML = v.pages.map((u, i) =>
        `<div class="fs-sp" data-i="${i}"><img data-src="${esc(imgUrl(u))}" alt="第 ${i + 1} 页"></div>`
      ).join('');
    }
    const page = box.querySelector(`.fs-sp[data-i="${FS.idx}"]`);
    if (page) {
      try { box.scrollTop = page.offsetTop; } catch { /* ignore */ }
    }
    // 首屏兜底：先无条件加载前几张，保证一进来就有内容
    const firstImgs = box.querySelectorAll('.fs-sp img[data-src]');
    for (let i = 0; i < Math.min(3, firstImgs.length); i++) {
      const im = firstImgs[i];
      im.addEventListener('load', () => im.classList.add('on'), { once: true });
      im.src = im.dataset.src;
      im.removeAttribute('data-src');
    }
    // 再按可视范围补（不放进 rAF：后台标签页 rAF 会被暂停）
    fsScrollHydrate();
    fsUpdateNum([FS.idx], n);
  }

  /** 按可视范围补图。
   *  不能用 IntersectionObserver：img 还没 src 时是 0 尺寸，
   *  IO 判不到相交，图就永远不加载。这里按容器可视区算，顺序扫描、命中即停。
   */
  function fsScrollHydrate() {
    const box = FS.el && FS.el.querySelector('#fsScroll');
    if (!box || FS.mode !== 'scroll') return;
    const boxTop = box.getBoundingClientRect().top;
    const boxH = box.clientHeight || window.innerHeight;
    const pad = 900;
    const sps = box.querySelectorAll('.fs-sp');
    let loaded = 0;
    for (let i = 0; i < sps.length; i++) {
      const sp = sps[i];
      const r = sp.getBoundingClientRect();
      const rel = r.top - boxTop;
      if (rel > boxH + pad) break;              // 往下更远，不用看了
      if (rel + r.height < -pad) continue;      // 已经滚过去的，跳过
      const img = sp.querySelector('img[data-src]');
      if (!img) continue;
      img.addEventListener('load', () => img.classList.add('on'), { once: true });
      img.src = img.dataset.src;
      img.removeAttribute('data-src');
      if (++loaded >= 6) break;                 // 一轮最多补 6 张，别一次打满
    }
  }

  let fsScrollLast = 0;
  function fsScrollOnScroll() {
    if (!FS.open || FS.mode !== 'scroll') return;
    // 不用 rAF 节流：标签页在后台时 rAF 会被暂停，滚动补图就停了
    const now = Date.now();
    if (now - fsScrollLast < 90) return;
    fsScrollLast = now;

    fsScrollHydrate();

    const box = FS.el && FS.el.querySelector('#fsScroll');
    const v = store.view;
    if (!box || !v) return;
    const items = box.querySelectorAll('.fs-sp');
    if (!items.length) return;
    const probe = box.scrollTop + box.clientHeight * 0.3;
    let cur = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].offsetTop <= probe) cur = i;
      else break;
    }
    FS.idx = cur;
    fsUpdateNum([cur], items.length);
  }

  /** 切换阅读模式；阅读中切换立即生效，不在阅读中则只改默认值 */
  function fsSetMode(mode) {
    FS.mode = mode === 'scroll' ? 'scroll' : 'flip';
    saveMode(FS.mode);
    fsSyncModeUi();
    if (FS.open) {
      if (FS.mode === 'scroll') fsScrollRender(false);
      else fsRender();
      fsScheduleHide();
    }
  }

  function fsRender() {
    const v = store.view;
    if (!v || !FS.open) return;
    const el = fsEnsureEl();
    const stage = el.querySelector('#fsStage');
    const n = v.pages.length;

    FS.spread = fsSpreadNow();
    if (FS.spread && FS.idx % 2 === 1) FS.idx -= 1;   // 双页对齐到偶数页
    if (FS.idx < 0) FS.idx = 0;
    if (FS.idx > n - 1) FS.idx = Math.max(0, n - 1);

    const ids = [FS.idx];
    if (FS.spread && FS.idx + 1 < n) ids.push(FS.idx + 1);

    stage.classList.toggle('spread', ids.length > 1);
    stage.innerHTML = `<div class="fs-sheet">${ids.map(i =>
      `<img class="fs-page" src="${esc(imgUrl(v.pages[i]))}" data-i="${i}" alt="第 ${i + 1} 页">`
    ).join('')}</div>`;

    fsUpdateNum(ids, n);
    fsPrefetch(ids, n);
    fsSyncRtlUi();
  }

  /* 平移翻页：旧页滑出、新页从另一侧推入。
   * 方向要同时考虑「翻页方向」和「阅读方向」：
   *   LTR（从左往右）：下一页在右边 → 新页从右侧进、旧页往左出
   *   RTL（日漫）：   下一页在左边 → 新页从左侧进、旧页往右出
   */
  let fsAnimating = false;

  function fsSlide(toIdx, dir) {
    const v = store.view;
    if (!v || !FS.open) return;
    const stage = FS.el.querySelector('#fsStage');
    if (!stage) return;
    const n = v.pages.length;
    const spread = fsSpreadNow();
    const targetIds = [toIdx];
    if (spread && toIdx + 1 < n) targetIds.push(toIdx + 1);

    // 视觉平移方向：RTL 反向
    const slideDir = dir * (FS.rtl ? -1 : 1);
    const inFrom = slideDir > 0 ? '100%' : '-100%';    // 新页起始位置
    const outTo = slideDir > 0 ? '-100%' : '100%';     // 旧页结束位置

    const oldSheet = stage.querySelector('.fs-sheet');
    const sheet = document.createElement('div');
    sheet.className = 'fs-sheet';
    sheet.innerHTML = targetIds.map(i =>
      `<img class="fs-page" src="${esc(imgUrl(v.pages[i]))}" data-i="${i}" alt="第 ${i + 1} 页">`
    ).join('');
    sheet.style.transform = `translateX(${inFrom})`;
    stage.classList.toggle('spread', targetIds.length > 1);
    stage.appendChild(sheet);
    fsSyncRtlUi();

    void sheet.offsetWidth;                     // 强制重排，让下面的过渡生效
    const ease = 'transform .26s cubic-bezier(.22,.61,.36,1)';
    sheet.style.transition = ease;
    if (oldSheet) oldSheet.style.transition = ease;
    sheet.style.transform = 'translateX(0)';
    if (oldSheet) oldSheet.style.transform = `translateX(${outTo})`;

    fsAnimating = true;
    fsUpdateNum(targetIds, n);                  // 页码立即跟上
    fsPrefetch(targetIds, n);
    clearTimeout(FS.animTimer);
    FS.animTimer = setTimeout(() => {
      fsAnimating = false;
      if (oldSheet) {
        // 清掉 src，让浏览器释放这屏大图的解码内存（大图累积是卡死的另一个来源）
        oldSheet.querySelectorAll('img').forEach(im => { im.src = ''; });
        oldSheet.remove();
      }
      sheet.style.transition = '';
      sheet.style.transform = '';
    }, 270);
  }

  function fsMove(dir) {           // dir = +1 下一页（往左翻），-1 上一页
    const v = store.view;
    if (!v) return;
    if (fsAnimating) return;     // 动画进行中，忽略连击，避免撕裂
    const n = v.pages.length;
    const step = FS.spread ? 2 : 1;
    let next = FS.idx + dir * step;
    if (next < 0) next = 0;
    if (next > n - 1) next = n - 1;
    if (FS.spread && next % 2 === 1) next -= 1;
    if (next === FS.idx) return;
    FS.idx = next;
    fsSlide(next, dir);          // 翻页不再顺带把工具栏弹出来
  }

  /* 物理按键翻页：iOS 不向网页暴露音量键（WebKit 无该 API），
   * 但音量键在被接管为媒体控制时，蓝牙耳机 / 有线线控 / 外接键盘的
   * 上一首·下一首 会走 MediaSession，这里接管它做翻页。
   */
  function fsSetupMediaKeys() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('nexttrack', () => { if (FS.open) fsMove(1); });
      navigator.mediaSession.setActionHandler('previoustrack', () => { if (FS.open) fsMove(-1); });
      // 部分设备把音量键映射成「快进/快退」
      navigator.mediaSession.setActionHandler('seekforward', () => { if (FS.open) fsMove(1); });
      navigator.mediaSession.setActionHandler('seekbackward', () => { if (FS.open) fsMove(-1); });
    } catch { /* 不支持就算了，不影响其它操作 */ }
  }

  /** MediaSession 需要有活跃媒体会话才会分发按键，用一个静音循环激活 */
  function fsKeepMediaSession() {
    if (FS.silent) return;
    try {
      const a = document.createElement('audio');
      a.loop = true;
      a.volume = 0;
      a.setAttribute('playsinline', '');
      // 44 字节的合法空 WAV
      a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
      document.body.appendChild(a);
      a.play().catch(() => { /* 被拦截就等下次手势 */ });
      FS.silent = a;
    } catch { /* ignore */ }
  }

  function fsOpen(startIdx) {
    const v = store.view;
    if (!v || !v.pages || !v.pages.length) return;
    FS.open = true;
    FS.mode = readMode();
    FS.spread = fsSpreadNow();
    FS.idx = Math.max(0, Math.min(Number(startIdx) || 0, v.pages.length - 1));
    fsEnsureEl().classList.add('on');
    fsSyncModeUi();
    document.body.classList.add('fs-lock');
    // 换作品时重置跳转面板
    const jg = FS.el.querySelector('#fsJumpGrid');
    if (jg) { jg.dataset.for = ''; jg.innerHTML = ''; }
    fsJumpClose();
    if (FS.mode === 'scroll') fsScrollRender(true);
    else fsRender();
    fsScheduleHide();
    // MediaSession（为音量键做的那套）先不启用：音量键在 iOS 网页层本来就无效，
    // 而它要挂一个静音循环 <audio>，多一个不确定因素，出问题不好排查。
    // fsSetupMediaKeys();
    // fsKeepMediaSession();

    // 请求浏览器真全屏（电脑上=整屏；iPad Safari 不支持时会自动留在覆盖层，视觉一样）
    try {
      const de = document.documentElement;
      if (de.requestFullscreen && !document.fullscreenElement) {
        de.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      }
    } catch { /* 不支持就算了 */ }
  }

  function fsClose() {
    if (!FS.open) return;
    const back = FS.idx;
    FS.open = false;
    fsAnimating = false;
    clearTimeout(FS.animTimer);
    clearTimeout(FS.hideTimer);
    FS.el?.classList.remove('on');
    document.body.classList.remove('fs-lock');
    if (FS.silent) { try { FS.silent.pause(); } catch { /* ignore */ } }

    // ① 先清空全屏层里的图片并移除节点：大图解码位图不释放会一直吃内存
    const stage = FS.el && FS.el.querySelector('#fsStage');
    if (stage) {
      stage.querySelectorAll('img').forEach(im => { im.src = ''; });
      stage.innerHTML = '';
    }
    const sc = FS.el && FS.el.querySelector('#fsScroll');
    if (sc) {
      sc.querySelectorAll('img').forEach(im => { im.src = ''; im.removeAttribute('data-src'); });
      sc.innerHTML = '';
      sc.scrollTop = 0;
      sc.dataset.for = '';
    }
    const jg = FS.el && FS.el.querySelector('#fsJumpGrid');
    if (jg) jg.querySelectorAll('img').forEach(im => { im.removeAttribute('src'); });

    // ② 再退出浏览器真全屏 —— 放在清理之后，重排时页面上已经没有大图了
    if (document.fullscreenElement) {
      requestAnimationFrame(() => {
        try { document.exitFullscreen?.()?.catch?.(() => {}); } catch { /* ignore */ }
      });
    }

    // ③ 阅读中可能切过模式，把详情页上的选中态同步回来
    const wrap = document.querySelector('.mode-switch');
    if (wrap) {
      const mode = readMode();
      wrap.querySelectorAll('.mode-opt').forEach(b => {
        b.classList.toggle('on', b.dataset.act === (mode === 'scroll' ? 'mode-scroll' : 'mode-flip'));
      });
    }
  }

  /* ---------------- 键盘 ---------------- */
  window.addEventListener('keydown', e => {
    // ---- 阅读器（两种模式共用 Esc 退出、M 切换模式） ----
    if (FS.open) {
      if (e.key === 'Escape') { e.preventDefault(); fsClose(); return; }
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        fsSetMode(FS.mode === 'scroll' ? 'flip' : 'scroll');
        return;
      }

      if (FS.mode === 'scroll') {
        const box = FS.el && FS.el.querySelector('#fsScroll');
        const step = window.innerHeight * 0.9;
        if (['ArrowDown', 'PageDown', ' '].includes(e.key)) {
          e.preventDefault(); if (box) box.scrollBy({ top: step, behavior: 'smooth' }); return;
        }
        if (['ArrowUp', 'PageUp'].includes(e.key)) {
          e.preventDefault(); if (box) box.scrollBy({ top: -step, behavior: 'smooth' }); return;
        }
        if (e.key === 'Home') { e.preventDefault(); if (box) box.scrollTop = 0; return; }
        if (e.key === 'End') { e.preventDefault(); if (box) box.scrollTop = box.scrollHeight; return; }
        return;
      }

      // 翻页模式：← 下一页、→ 上一页（日漫从右往左）
      if (['ArrowLeft', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); fsMove(fsDirFromLeft(true)); return; }
      if (['ArrowRight', 'PageUp'].includes(e.key)) { e.preventDefault(); fsMove(fsDirFromLeft(false)); return; }
      if (e.key === 'Home') { e.preventDefault(); FS.idx = 0; fsRender(); return; }
      if (e.key === 'End') { e.preventDefault(); FS.idx = Math.max(0, (store.view?.pages.length || 1) - 1); fsRender(); return; }
      return;
    }

    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      if (e.key === 'Escape') { e.target.blur(); }
      return;
    }
    const cur = currentRoute();
    if (e.key === 'Escape' && cur.name === 'reader') { location.hash = '#/'; return; }
    if (cur.name !== 'reader') return;

    // F：从详情页开始阅读
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      fsOpen(0);
      return;
    }
  });

  /* 横竖屏切换时自动在单页 / 双页之间切换（仅翻页模式） */
  window.addEventListener('resize', () => {
    if (!FS.open || FS.mode === 'scroll') return;
    const was = FS.spread;
    FS.spread = fsSpreadNow();
    if (was !== FS.spread) fsRender();
  });

  /* ---------------- 事件 ---------------- */
  // 待执行的搜索：从阅读器点标签跳回列表时用，避免和 hashchange 抢
  let pendingSearch = null;

  function runSearch(q, sort) {
    document.getElementById('q').value = q;
    store.view = null;
    if (currentRoute().name !== 'list') {
      pendingSearch = { q, sort: sort || store.list.sort };
      location.hash = '#/';
    } else {
      renderList({ q, sort: sort || store.list.sort, reload: true });
    }
  }

  document.addEventListener('click', e => {
    // ---- 全屏阅读：点左半 = 下一页（日漫往左翻），点右半 = 上一页 ----
    if (FS.open) {
      // 刚做完滑动手势时，抑制浏览器补发的 click，避免一次操作翻两屏
      if (Date.now() < fsSuppressClick) { e.preventDefault(); return; }

      // 缩略图跳转
      const jumpItem = e.target.closest('[data-jump-i]');
      if (jumpItem) {
        e.preventDefault();
        const ti = Number(jumpItem.dataset.jumpI) || 0;
        if (FS.mode === 'scroll') {
          // 滚动模式：直接滚到那一页
          const box = FS.el && FS.el.querySelector('#fsScroll');
          const p = box && box.querySelector(`.fs-sp[data-i="${ti}"]`);
          if (p) box.scrollTop = p.offsetTop;
          FS.idx = ti;
          fsUpdateNum([ti], store.view.pages.length);
          fsJumpClose();
        } else {
          fsGoto(ti);
        }
        return;
      }

      const fb = e.target.closest('[data-act]');
      if (fb) {
        const a = fb.dataset.act;
        if (a === 'fs-prev') { e.preventDefault(); if (FS.mode !== 'scroll') fsMove(-1); return; }
        if (a === 'fs-next') { e.preventDefault(); if (FS.mode !== 'scroll') fsMove(1); return; }
        if (a === 'fs-jump-toggle') { e.preventDefault(); fsJumpToggle(); return; }
        if (a === 'fs-mode') { e.preventDefault(); fsSetMode(FS.mode === 'scroll' ? 'flip' : 'scroll'); return; }
        if (a === 'fs-rtl') { e.preventDefault(); fsToggleRtl(); return; }
        if (a === 'fs-close') { e.preventDefault(); fsClose(); return; }
      }
      if (e.target.closest('.fs')) {
        // 点到工具栏或跳转面板就不要翻页
        if (e.target.closest('.fs-bar') || e.target.closest('.fs-jump')) return;
        if (FS.mode === 'scroll') return;      // 滚动模式：点屏幕不翻页，交给滚动
        const x = e.clientX / window.innerWidth;
        fsMove(fsDirFromLeft(x < 0.5));   // 点按翻页同样不弹工具栏
      }
      return;
    }

    // 「相关」下拉里的作品 → 直接打开
    const relItem = e.target.closest('[data-fs-rel-id]');
    if (relItem) {
      e.preventDefault();
      relToggle(false);
      const rid = relItem.dataset.fsRelId;
      if (rid && rid !== String(store.view?.id)) location.hash = '#/v/' + rid;
      return;
    }

    // 点其它地方关闭「相关」下拉
    if (!e.target.closest('.rel-wrap')) {
      const pop = document.getElementById('relPop');
      if (pop && pop.classList.contains('open')) pop.classList.remove('open');
    }

    // 相关作品 → 直接打开那一本
    const relBtn = e.target.closest('[data-rel-id]');
    if (relBtn) {
      e.preventDefault();
      const rid = relBtn.dataset.relId;
      if (rid && rid !== String(store.view?.id)) location.hash = '#/v/' + rid;
      return;
    }

    // 标签 → 按类型精确搜索
    const tagBtn = e.target.closest('[data-tag]');
    if (tagBtn) {
      e.preventDefault();
      const tag = tagBtn.dataset.tag || '';
      const type = tagBtn.dataset.tagType || 'tag';
      if (tag) runSearch(`${type}:"${tag}"`);
      return;
    }

    // 语言筛选（默认中文）
    const langBtn = e.target.closest('[data-lang]');
    if (langBtn) {
      e.preventDefault();
      const lang = langBtn.dataset.lang;
      if (lang !== store.list.lang) {
        store.view = null;
        renderList({ q: store.list.q, sort: store.list.sort, lang, reload: true });
      }
      return;
    }

    // 排序切换
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      e.preventDefault();
      const s = sortBtn.dataset.sort;
      if (s !== store.list.sort) {
        store.view = null;
        renderList({ q: store.list.q, sort: s, reload: true });
      }
      return;
    }

    const btn = e.target.closest('[data-act]');
    if (btn) {
      const act = btn.dataset.act;

      // 标题向上收起 / 展开
      if (act === 'title-toggle') {
        e.preventDefault();
        titleCollapsed = !titleCollapsed;
        saveTitleCollapsed(titleCollapsed);
        const h = document.querySelector('.reader-title');
        const b = document.querySelector('.title-toggle-btn');
        if (h) h.classList.toggle('collapsed', titleCollapsed);
        if (b) b.textContent = titleCollapsed ? '▸ 标题' : '▾ 标题';
        return;
      }

      // 左上角品牌 → 回主界面（退出全屏、清空搜索、回到列表顶部）
      if (act === 'home') {
        e.preventDefault();
        goHome();
        return;
      }

      if (act === 'refresh') { store.view = null; renderList({ reload: true }); }
      else if (act === 'retry-view') { store.view = null; currentRoute().name === 'reader' ? renderReader(currentRoute().id) : renderList({ reload: true }); }
      else if (act === 'back') location.hash = '#/';
      else if (act === 'more') loadMore(false);
      else if (act === 'fav-toggle') toggleFav(btn);
      else if (act === 'retry-fav') renderFav();
      else if (act === 'mode-flip' || act === 'mode-scroll') {
        // 详情页上的阅读模式开关：改默认值，下次「开始阅读」就按它进
        fsSetMode(act === 'mode-scroll' ? 'scroll' : 'flip');
        const wrap = btn.closest('.mode-switch');
        if (wrap) wrap.querySelectorAll('.mode-opt').forEach(b => b.classList.toggle('on', b === btn));
        return;
      }
      else if (act === 'toggle-tags') {
        const box = document.getElementById('tagsBox');
        if (box) {
          const collapsed = box.classList.toggle('collapsed');
          btn.textContent = collapsed ? (btn.dataset.label || '展开全部标签 ▾') : '收起标签 ▴';
        }
      }
      else if (act === 'rel-search') {
        const q = versionsQuery();
        if (q) runSearch(q);
        return;
      }
      else if (act === 'rel-zh') {
        const artist = (store.view?.tags || []).find(t => String(t.type || '').toLowerCase() === 'artist');
        if (artist) runSearch(`artist:"${artist.name}" language:"chinese"`);
        return;
      }
      else if (act === 'rel-toggle') { e.preventDefault(); relToggle(); return; }
      else if (act === 'fs-enter') {
        fsOpen(0);          // 从第 1 页开始读（阅读模式由设置决定）
      }
      return;
    }

    // 兜底：任何非页内 hash 的链接一律拦下，绝不开新标签
    const a = e.target.closest('a[href]');
    if (a) {
      const href = a.getAttribute('href') || '';
      if (!href.startsWith('#')) e.preventDefault();
    }
  }, true);

  document.addEventListener('submit', e => {
    if (e.target.id !== 'searchForm') return;
    e.preventDefault();
    const q = (document.getElementById('q').value || '').trim();
    runSearch(q);
  });

  /* 回主界面：退出全屏 → 清空搜索 → 回到列表顶部 */
  function goHome() {
    if (FS.open) fsClose();
    store.view = null;
    const qEl = document.getElementById('q');
    if (qEl) qEl.value = '';
    store.list.q = '';
    if (currentRoute().name === 'list') {
      renderList({ q: '', sort: store.list.sort, reload: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      location.hash = '#/';
    }
  }

  /* 顶栏按钮：必须在 buildShell 之后才能拿到节点 */
  function bindTopbar() {
    document.getElementById('backBtn').addEventListener('click', () => { location.hash = '#/'; });
    document.getElementById('favBtn').addEventListener('click', () => { location.hash = '#/fav'; });
    document.getElementById('refreshBtn').addEventListener('click', () => {
      store.view = null;
      if (currentRoute().name === 'fav') renderFav();
      else renderList({ reload: true });
    });
  }

  /* 收藏 / 取消收藏 */
  async function toggleFav(btn) {
    const v = store.view;
    if (!v || btn.disabled) return;
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '…';
    try {
      const j = await api('/api/fav', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: v.id,
          action: 'toggle',
          title: v.title,
          titleJp: v.titleJp,
          cover: v.cover,
          pages: v.numPages,
          lang: v.lang,
        }),
      });
      if (j.starred) {
        store.favs.set(String(v.id), {
          id: v.id, title: v.title, titleJp: v.titleJp,
          cover: v.cover, pages: v.numPages, lang: v.lang, addedAt: Date.now(),
        });
        btn.textContent = '★ 已收藏';
        btn.classList.add('on');
      } else {
        store.favs.delete(String(v.id));
        btn.textContent = '☆ 收藏';
        btn.classList.remove('on');
      }
    } catch (e) {
      btn.textContent = '操作失败';
      setTimeout(() => { btn.textContent = old; }, 1600);
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- 路由 ---------------- */
  function currentRoute() {
    const h = (location.hash || '#/').replace(/^#/, '');
    if (h === '/fav' || h === '/fav/') return { name: 'fav' };
    const m = /^\/v\/(\d{1,12})$/.exec(h);
    return m ? { name: 'reader', id: m[1] } : { name: 'list' };
  }

  function dispatch() {
    // 路由一变就先关掉阅读器覆盖层：
    // 系统返回键/浏览器回退会直接改 hash，FS 只是个 JS 状态，不关就会挂在新页面上
    if (FS.open) fsClose();
    const r = currentRoute();
    if (r.name === 'reader') return renderReader(r.id);
    if (r.name === 'fav') return renderFav();
    if (pendingSearch) {
      const p = pendingSearch;
      pendingSearch = null;
      return renderList({ q: p.q, sort: p.sort, reload: true });
    }
    renderList({});
  }

  window.addEventListener('hashchange', dispatch);

  buildShell();
  bindTopbar();
  dispatch();
})();
