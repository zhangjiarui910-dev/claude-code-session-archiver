/*
 * cc-session-backup.js —— Claude Code Web 会话的本地备份脚本
 *
 * 用法：在已登录的会话页面打开控制台，整段粘贴后回车。
 *   - 弹出选择文件窗口时，选「最近一次备份的 JSON」→ 只保存那之后的新内容
 *   - 在选择窗口里点「取消」→ 做一次完整备份（从底部一直扫到开头）
 *   - 运行中想停下：在控制台输入 ccStop() 回车，已收集的内容会照常保存
 *
 * 脚本做什么：
 *   - 从页面最底部（最新消息）向上滚动，读取已显示的消息
 *   - 靠每条消息自带的固定编号（data-entry-key）找到上次备份的结尾，找到就停
 *   - 在本机生成并下载两个文件：.json 和离线 .html
 *
 * 脚本不做什么：
 *   - 不发任何网络请求、不上传任何内容
 *   - 不读取 Cookie / Token / localStorage，不调用任何接口
 *   - 不修改页面内容、不点击页面上的按钮、不发送消息（只滚动聊天区域）
 *
 * 诚实原则：找不到上次备份的结尾时，绝不会把重扫到的旧内容叫做「新增」，
 *           而是在控制台、JSON、HTML 和文件名里都明确标出来。
 */
(async () => {
  'use strict';

  const VERSION = '1.3';
  const CFG = {
    OLD_JSON: 'ask', // 'ask' = 弹窗选择上次的 JSON；'none' = 不选，直接做完整备份
    IGNORE_SESSION_MISMATCH: false, // 选的旧文件属于别的会话时是否仍然继续
    STEP_RATIO: 0.85, // 每次向上滚动聊天区域高度的多少
    SETTLE_MIN_MS: 80, // 每滚一步至少等这么久
    SETTLE_QUIET_MS: 150, // 页面这么久没有变化才算稳定
    SETTLE_MAX_MS: 2500, // 每步最多等这么久
    RUN_ID: 3, // 连续多少条「编号在旧文件里」才算找到分界
    RUN_TEXT: 5, // 没有编号时，连续多少条「内容在旧文件里」才算找到分界
    MIN_TEXT: 24, // 少于这么多字的内容太容易重复，不参与内容比对
    TOP_RETRIES: 4, // 到顶后再确认几次
    STUCK_STEPS: 80, // 连续这么多步都没有新内容，才判定页面卡住
    STUCK_WAIT_MAX_MS: 4000, // 没有新内容时，每步额外多等，最多等这么久（网络慢时给页面时间加载）
    TAIL_ANCHOR: 40, // 每个备份文件里记下最新的多少条编号，供下次定位
    BIG_TEXT_CAP: 40e6, // 旧格式文件参与内容比对的最大字符数
    LOG_EVERY: 25,
  };

  const ROW_SEL = '[data-testid="transcript-row"]';
  const KEY_ATTRS = ['data-entry-key', 'data-epitaxy-entry', 'data-turn-key'];
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const FORMAT = 'cc-session-backup/v2';

  const log = (...a) => console.log('%c[备份]', 'color:#0a7;font-weight:bold', ...a);
  const warn = (...a) => console.warn('[备份] ⚠', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (window.ccStop) {
    warn('上一次备份还在运行。想停止它，请输入 ccStop() 回车。');
    return;
  }

  // ---------- 小工具 ----------
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const mur = (s) => {
    let h = 0x9747b28c;
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 0x5bd1e995);
      h ^= h >>> 15;
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const fp = (s) => fnv(s) + mur(s); // 内容指纹（64 位）
  const strip = (s) => (s || '').replace(/\s+/g, '');
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');

  // ---------- 找到聊天区域 ----------
  const rowEls = () =>
    [...document.querySelectorAll(ROW_SEL)].filter((el) => !el.parentElement || !el.parentElement.closest(ROW_SEL));
  const keyOf = (el) => {
    for (const attr of KEY_ATTRS) {
      const hit = el.hasAttribute(attr) ? [el] : [...el.querySelectorAll('[' + attr + ']')];
      const keys = [...new Set(hit.map((n) => n.getAttribute(attr)).filter(Boolean))];
      if (keys.length) return keys;
    }
    return [];
  };

  const firstRow = rowEls()[0];
  if (!firstRow) {
    warn('没有在页面上找到聊天内容。请确认当前打开的是要备份的会话页面，然后重新粘贴运行。什么都没有保存。');
    return;
  }
  let scroller = null;
  for (let p = firstRow.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 50) {
      scroller = p;
      break;
    }
  }
  if (!scroller) scroller = document.scrollingElement;
  {
    const rows = rowEls();
    const keyed = rows.filter((r) => keyOf(r).length).length;
    if (keyed < rows.length * 0.5) {
      warn(
        `页面上 ${rows.length} 条消息里只有 ${keyed} 条带固定编号，和检测时的情况不一样（页面可能更新了）。` +
          '为避免存出不可靠的文件，已停止，什么都没有保存。'
      );
      return;
    }
  }

  const session = {
    url: location.href,
    title: document.title,
    pathHash: fnv(location.pathname),
  };

  // ---------- 把一条消息转成干净的 HTML（只读原页面，不克隆、不改动） ----------
  const KEEP = new Set(
    'p pre code ul ol li table thead tbody tfoot tr th td a h1 h2 h3 h4 h5 h6 strong b em i u s del ins blockquote br hr sup sub kbd mark small details summary dl dt dd caption'.split(
      ' '
    )
  );
  const BLOCK = new Set('div section article header footer main nav aside figure figcaption form fieldset address'.split(' '));
  const DROP = new Set(
    'script style link meta svg canvas iframe noscript template input textarea select option video audio source picture object embed'.split(
      ' '
    )
  );
  // 页面上有些文字是「只给读屏软件念、眼睛看不到」的（例如每条消息前的 "You said: …" 摘要），不存它们
  const visuallyHidden = (el, cs) => {
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(cs.clipPath || '')) return true;
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if ((r.width <= 1.5 || r.height <= 1.5) && cs.overflow !== 'visible') return true;
    }
    return false;
  };
  function serChildren(node, out, hidden) {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3) {
        out.push(esc(c.nodeValue));
        continue;
      }
      if (c.nodeType !== 1 || c.namespaceURI !== XHTML) continue;
      const tag = c.localName;
      if (DROP.has(tag)) continue;
      if (tag === 'img') {
        const alt = c.getAttribute('alt');
        out.push('<span class="img">[图片' + (alt ? '：' + esc(alt) : '') + ']</span>');
        continue;
      }
      const cs = getComputedStyle(c);
      if (cs.display === 'none') continue;
      if (visuallyHidden(c, cs)) {
        const ht = (c.innerText || c.textContent || '').trim();
        if (ht && hidden) hidden.push(ht);
        continue;
      }
      if (tag === 'br' || tag === 'hr') {
        out.push('<' + tag + '>');
        continue;
      }
      let t = 'span';
      let attrs = '';
      if (KEEP.has(tag)) t = tag;
      else if (BLOCK.has(tag)) t = 'div';
      else if (tag === 'button') attrs = ' class="btn"';
      if (tag === 'a') {
        const href = c.href || '';
        if (/^(https?:|mailto:)/i.test(href)) attrs += ' href="' + esc(href) + '" rel="noopener noreferrer"';
      } else if (tag === 'td' || tag === 'th') {
        for (const a of ['colspan', 'rowspan']) {
          const v = c.getAttribute(a);
          if (v && /^\d+$/.test(v)) attrs += ' ' + a + '="' + v + '"';
        }
      } else if (tag === 'ol') {
        const v = c.getAttribute('start');
        if (v && /^-?\d+$/.test(v)) attrs += ' start="' + v + '"';
      } else if (tag === 'code' || tag === 'pre') {
        const m = (c.getAttribute('class') || '').match(/\blanguage-[\w+-]+/);
        if (m) attrs += ' class="' + m[0] + '"';
      }
      const inner = [];
      serChildren(c, inner, hidden);
      const body = inner.join('');
      if (!body.trim() && tag !== 'td' && tag !== 'th') continue; // 丢掉空壳
      out.push('<' + t + attrs + '>' + body + '</' + t + '>');
    }
  }
  const cleanHtml = (el, hidden) => {
    const out = [];
    serChildren(el, out, hidden);
    return out.join('');
  };

  // ---------- 读取当前已显示的消息 ----------
  function snapshot() {
    const sRect = scroller.getBoundingClientRect();
    const items = [];
    for (const el of rowEls()) {
      const tc = strip(el.textContent);
      const keys = keyOf(el);
      if (!keys.length && !tc) continue; // 空的占位行
      const r = el.getBoundingClientRect();
      const inView = r.height > 0 && r.bottom > sRect.top + 1 && r.top < sRect.bottom - 1;
      const di = el.getAttribute('data-index');
      const key = keys[0] || null;
      const last = items[items.length - 1];
      if (key && last && last.key === key) {
        // 同一条消息占了相邻的多行：合并成一条
        last.els.push(el);
        last.tc += tc;
        last.inView = last.inView && inView;
        for (const k of keys) if (!last.keys.includes(k)) last.keys.push(k);
        continue;
      }
      items.push({ key, keys, els: [el], tc, inView, dataIndex: di != null && /^\d+$/.test(di) ? Number(di) : null });
    }
    const seen = new Map();
    for (const it of items) {
      it.fp = fp(it.tc);
      let id = it.key ? 'k:' + it.key : 'n:' + (it.dataIndex != null ? it.dataIndex : it.fp);
      const n = (seen.get(id) || 0) + 1;
      seen.set(id, n);
      if (n > 1) id += '#' + n;
      it.id = id;
    }
    return items;
  }

  function materialize(it, rec) {
    const texts = [];
    const htmls = [];
    let time = null;
    let streaming = false;
    let user = false;
    for (const el of it.els) {
      const hidden = [];
      htmls.push(cleanHtml(el, hidden));
      let t = el.innerText || '';
      for (const h of hidden) {
        const at = t.indexOf(h);
        if (at >= 0) t = t.slice(0, at) + t.slice(at + h.length);
      }
      t = t.trim();
      texts.push(t || (el.textContent || '').replace(/\s+/g, ' ').trim());
      if (!time) {
        const tm = el.querySelector('time[datetime]');
        if (tm) time = tm.getAttribute('datetime');
      }
      if (el.getAttribute('data-perf-row-streaming') === 'true' || el.querySelector('[data-is-streaming="true"]')) streaming = true;
      if (el.querySelector('[data-user-scope]')) user = true;
    }
    rec.id = it.id;
    rec.key = it.key;
    rec.keys = it.keys;
    rec.parts = it.els.length;
    rec.dataIndex = it.dataIndex;
    rec.fp = it.fp;
    rec.tc = it.tc;
    rec.text = texts.join('\n');
    rec.it = strip(rec.text);
    rec.html = htmls.join('\n');
    rec.time = time;
    rec.streaming = streaming;
    rec.kindGuess = user ? 'user' : it.key && it.key.startsWith('msg_') ? 'assistant' : 'other';
    rec.match = null; // 与旧文件的比对结果需要重算
    return rec;
  }

  // ---------- 收集与排序 ----------
  const recs = new Map(); // id -> 记录
  let order = []; // 从旧到新的 id 列表
  let gaps = 0;

  function merge(items) {
    if (!items.length) return { added: 0, overlap: order.length === 0 };
    const exists = items.map((it) => recs.has(it.id));
    const overlap = exists.some(Boolean);
    if (order.length && !overlap) return { added: 0, overlap: false };
    let added = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (exists[i]) {
        const rec = recs.get(it.id);
        const better =
          it.els.length > rec.parts ||
          (it.els.length === rec.parts && it.fp !== rec.fp && (it.inView || !rec.seenInView));
        if (better) materialize(it, rec);
        if (it.inView) rec.seenInView = true;
        continue;
      }
      const rec = materialize(it, { seenInView: it.inView });
      recs.set(it.id, rec);
      added++;
      if (!order.length) {
        order.push(it.id);
        continue;
      }
      let j = i + 1;
      while (j < items.length && !exists[j]) j++;
      if (j < items.length) {
        order.splice(order.indexOf(items[j].id), 0, it.id);
      } else if (i > 0) {
        order.splice(order.indexOf(items[i - 1].id) + 1, 0, it.id);
      } else {
        order.push(it.id);
      }
    }
    return { added, overlap: true };
  }

  function forcePrepend(items) {
    // 实在接不上时：照样收下，但记一处「可能有遗漏」
    const fresh = items.filter((it) => !recs.has(it.id));
    const ids = [];
    for (const it of fresh) {
      const rec = materialize(it, { seenInView: it.inView });
      rec.gapAfter = false;
      recs.set(it.id, rec);
      ids.push(it.id);
    }
    if (ids.length) {
      recs.get(ids[ids.length - 1]).gapAfter = true;
      order = ids.concat(order);
      gaps++;
    }
    return ids.length;
  }

  // ---------- 等页面稳定 ----------
  function settle() {
    return new Promise((res) => {
      const t0 = performance.now();
      let last = t0;
      const mo = new MutationObserver(() => {
        last = performance.now();
      });
      mo.observe(scroller, { subtree: true, childList: true, characterData: true, attributes: true });
      const tick = () => {
        const now = performance.now();
        if ((now - t0 >= CFG.SETTLE_MIN_MS && now - last >= CFG.SETTLE_QUIET_MS) || now - t0 >= CFG.SETTLE_MAX_MS) {
          mo.disconnect();
          res();
        } else setTimeout(tick, 30);
      };
      setTimeout(tick, 30);
    });
  }
  const fromBottom = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

  // 往上滚时，页面常常在顶部补加载更早的消息。有的页面不会替我们保持位置，
  // 视野就被一下子推到更早的地方，中间那段消息根本没出现过，就会漏存。
  // 发现页面变高、又和已收集的内容接不上时，把多出来的高度补回去，回到原处。
  let lastH = 0;
  // 补位/往下找如果连着几次都没带来新内容（在某些页面上会原地打转），就关掉，退回 1.1 的做法
  let rescueOff = false;
  let rescueUsed = false;
  let rescueFails = 0;
  async function realign(items) {
    if (rescueOff) return items;
    // 加载可能一批接一批地来，所以补完一次再看一次，直到接上或页面不再变高
    for (let k = 0; k < 10; k++) {
      const grew = scroller.scrollHeight - lastH;
      if (grew <= 1 || !order.length || items.some((it) => recs.has(it.id))) return items;
      scroller.scrollTop += grew;
      rescueUsed = true;
      lastH = scroller.scrollHeight;
      await settle();
      items = snapshot();
    }
    return items;
  }
  // 还是接不上：一点点往下找，直到重新看到已收集的消息
  async function seekDown(fromTop, step) {
    if (rescueOff) return null;
    rescueUsed = true;
    for (let k = 1; k <= 40; k++) {
      scroller.scrollTop = fromTop + Math.floor((step * k) / 4);
      await settle();
      const items = snapshot();
      if (items.some((it) => recs.has(it.id))) return items;
      if (fromBottom() <= 2) break;
    }
    return null;
  }

  // ---------- 读取上次的备份文件（只在本机读，不上传） ----------
  function pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input'); // 不放进页面，只用来弹出选择窗口
      input.type = 'file';
      input.accept = '.json,application/json';
      let done = false;
      const finish = (f) => {
        if (done) return;
        done = true;
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('focus', onFocus);
        resolve(f);
      };
      const onClick = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation(); // 这一下点击只用来弹窗，不让页面收到
        input.click();
      };
      const onFocus = () => setTimeout(() => !input.files.length && finish(null), 2000);
      input.addEventListener('change', () => finish(input.files[0] || null));
      input.addEventListener('cancel', () => finish(null));
      window.addEventListener('click', onClick, true);
      window.addEventListener('focus', onFocus);
      if (navigator.userActivation && navigator.userActivation.isActive) input.click();
      log('👉 如果没有弹出「选择文件」窗口，请用鼠标在聊天内容的空白处点一下。');
      log('   选「最近一次备份的 JSON」= 只存新内容；点「取消」= 做一次完整备份。');
    });
  }

  function parseOld(name, raw) {
    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch (_) {
      /* 不是合法 JSON：当作普通文本比对 */
    }
    if (obj && typeof obj === 'object' && typeof obj.format === 'string' && obj.format.startsWith('cc-session-backup/')) {
      const ids = new Set();
      const fpById = new Map();
      const fps = new Set();
      for (const r of obj.records || []) {
        if (r && r.key && r.id) {
          ids.add(r.id);
          fpById.set(r.id, r.fp);
        }
        if (r && r.fp) fps.add(r.fp);
      }
      for (const a of obj.tailAnchor || []) {
        if (a && a.id) {
          ids.add(a.id);
          if (!fpById.has(a.id)) fpById.set(a.id, a.fp);
          if (a.fp) fps.add(a.fp);
        }
      }
      const tail = (obj.tailAnchor && obj.tailAnchor.length
        ? obj.tailAnchor
        : (obj.records || []).filter((r) => r && r.key)
      )
        .filter((a) => a && a.id)
        .map((a) => ({ id: a.id, fp: a.fp }));
      return {
        type: 'v2',
        name,
        ids,
        fpById,
        fps,
        tail,
        big: '',
        sessionHash: obj.session && obj.session.pathHash,
        createdAt: obj.createdAt || null,
        count: (obj.records || []).length,
        lastWasStreaming: !!(obj.run && obj.run.streamingAtRun),
      };
    }
    // 旧格式（别的脚本存的）：不知道结构，只能通用地找编号和文字
    const ids = new Set(
      raw.match(/msg_[A-Za-z0-9]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []
    );
    const fps = new Set();
    const chunks = [];
    let count = null;
    const addText = (s) => {
      const t = strip(s);
      if (t.length < CFG.MIN_TEXT) return;
      fps.add(fp(t));
      chunks.push(t);
    };
    if (obj !== null) {
      const parser = new DOMParser();
      const stack = [obj];
      while (stack.length) {
        const v = stack.pop();
        if (typeof v === 'string') {
          addText(v);
          if (v.includes('<') && v.includes('>')) {
            const doc = parser.parseFromString(v, 'text/html'); // 离线解析，不会加载任何资源
            addText(doc.body ? doc.body.textContent : '');
          }
        } else if (Array.isArray(v)) {
          if (count === null || v.length > count) count = v.length;
          for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
        } else if (v && typeof v === 'object') {
          const vals = Object.values(v);
          for (let i = vals.length - 1; i >= 0; i--) stack.push(vals[i]);
        }
      }
    } else {
      chunks.push(strip(raw));
    }
    let big = chunks.join('\u0001');
    if (big.length > CFG.BIG_TEXT_CAP) big = big.slice(-CFG.BIG_TEXT_CAP);
    return { type: 'legacy', name, ids, fpById: new Map(), fps, big, sessionHash: null, createdAt: null, count };
  }

  // ---------- 判断一条消息是否在旧文件里 ----------
  let old = null;
  function matchOf(rec) {
    if (rec.match) return rec.match;
    let id = false;
    if (rec.key) {
      id = old.type === 'v2' ? old.ids.has(rec.id) : rec.keys.some((k) => old.ids.has(k));
    }
    let text = null; // null = 太短，不参与内容比对
    const hit = (s) => s.length >= CFG.MIN_TEXT && (old.fps.has(fp(s)) || (old.big !== '' && old.big.includes(s)));
    if (rec.tc.length >= CFG.MIN_TEXT || rec.it.length >= CFG.MIN_TEXT) text = hit(rec.tc) || hit(rec.it);
    rec.match = { id, text };
    return rec.match;
  }
  function findRun(score, need, by, atTop) {
    let run = 0;
    let newest = -1;
    for (let i = order.length - 1; i >= 0; i--) {
      const s = score(recs.get(order[i]));
      if (s === -1) continue;
      if (s === 1) {
        if (run === 0) newest = i;
        run++;
        if (run >= need) return { index: newest, by, run };
      } else run = 0;
    }
    if (atTop && run >= 1) return { index: newest, by, run };
    return null;
  }
  function findBoundary(atTop) {
    if (!old) return null;
    const byId = findRun((r) => (r.key ? (matchOf(r).id ? 1 : 0) : -1), CFG.RUN_ID, 'id', atTop);
    if (byId) return byId;
    if (old.type !== 'legacy') return null;
    return findRun(
      (r) => {
        const t = matchOf(r).text;
        return t === null ? -1 : t ? 1 : 0;
      },
      CFG.RUN_TEXT,
      'text',
      false
    );
  }

  // ---------- 开始 ----------
  let stopRequested = false;
  window.ccStop = () => {
    stopRequested = true;
    log('收到停止指令，正在收尾并保存已收集的内容…');
  };

  let result = null;
  try {
    if (CFG.OLD_JSON === 'ask') {
      const file = await pickFile();
      if (file) {
        log(`正在本机读取「${file.name}」…`);
        old = parseOld(file.name, await file.text());
        if (old.type === 'v2') {
          log(`这是本工具存的备份（${old.createdAt || '时间未知'}，${old.count} 条）。将按消息编号定位。`);
          if (old.sessionHash && old.sessionHash !== session.pathHash && !CFG.IGNORE_SESSION_MISMATCH) {
            warn('你选的备份文件属于另一个会话，不是当前打开的这个。已停止，什么都没有保存。请换成这个会话的备份文件再试。');
            return;
          }
        } else {
          log(
            `这是旧格式的备份文件（不是本工具存的）。在里面找到 ${old.ids.size} 个像消息编号的字符串，` +
              '将先按编号、再按内容尝试定位；对不上会明确告诉你。'
          );
        }
      } else {
        log('没有选择旧文件：这次做完整备份。');
      }
    }

    if (document.querySelector('[data-is-streaming="true"], [data-perf-row-streaming="true"]')) {
      warn('会话似乎还在输出内容。最好等它停下再备份；继续的话，最后一条可能不完整。');
    }
    if (document.hidden) warn('这个标签页现在在后台，扫描会非常慢。请保持它在前台。');

    // 先回到最底部（最新消息）
    for (let i = 0; i < 6; i++) {
      scroller.scrollTop = scroller.scrollHeight;
      await settle();
      if (fromBottom() <= 2) break;
    }
    let lastItems = snapshot();
    merge(lastItems);
    lastH = scroller.scrollHeight;
    const streamingAtRun = order.length ? !!recs.get(order[order.length - 1]).streaming : false;
    let totalRows = null;
    for (const id of order) {
      const d = recs.get(id).dataIndex;
      if (d != null && (totalRows === null || d + 1 > totalRows)) totalRows = d + 1;
    }
    log(`页面当前大约有 ${totalRows != null ? totalRows : '未知数量的'} 行。开始从最新消息向上扫描，期间请不要动这个页面。`);

    const t0 = performance.now();
    const step = Math.max(120, Math.floor(scroller.clientHeight * CFG.STEP_RATIO));
    let steps = 0;
    let boundary = null;
    let reachedTop = false;
    let aborted = null;
    let topStable = 0;
    let topChecks = 0;
    let noProgress = 0;
    let maxFromBottom = fromBottom();
    let bounced = 0;

    while (true) {
      boundary = findBoundary(false);
      if (boundary) break;
      if (stopRequested) break;

      if (scroller.scrollTop <= 1) {
        const h = scroller.scrollHeight;
        const n = order.length;
        await sleep(400);
        await settle();
        lastItems = await realign(snapshot());
        merge(lastItems);
        lastH = scroller.scrollHeight;
        if (scroller.scrollTop > 1) {
          topStable = 0; // 顶上又加载出了更早的内容，接着往上扫
          continue;
        }
        if (scroller.scrollTop <= 1 && scroller.scrollHeight === h && order.length === n) topStable++;
        else topStable = 0;
        if (++topChecks > 40) {
          aborted = '页面顶部的内容一直在变化，无法确认是否到了开头';
          break;
        }
        if (topStable >= CFG.TOP_RETRIES) {
          reachedTop = true;
          boundary = findBoundary(true);
          break;
        }
        continue;
      }

      const prevTop = scroller.scrollTop;
      const countBefore = order.length;
      rescueUsed = false;
      const topSeen = lastItems.find((it) => it.inView) || null; // 这一步之前，屏幕里最靠上的那条
      scroller.scrollTop = Math.max(0, prevTop - step);
      await settle();
      steps++;
      let items = await realign(snapshot());
      // 如果这一步滚过了头（上一屏最靠上的那条已经完全掉到屏幕下方），往回补一点，
      // 保证每条消息都在屏幕里完整出现过一次
      for (let k = 0; k < 3 && topSeen; k++) {
        const now = items.find((it) => it.id === topSeen.id);
        let back;
        if (now) {
          const gapPx = now.els[0].getBoundingClientRect().top - scroller.getBoundingClientRect().bottom;
          if (gapPx <= 0) break;
          back = Math.ceil(gapPx) + 40;
        } else back = Math.floor(step / 2);
        merge(items);
        scroller.scrollTop += back;
        await settle();
        items = snapshot();
      }
      let m = merge(items);

      if (!m.overlap) {
        // 和已收集的内容接不上：在中间位置补读几次
        for (const f of [0.5, 0.25, 0.75]) {
          scroller.scrollTop = Math.max(0, prevTop - Math.floor(step * f));
          await settle();
          merge(snapshot());
        }
        scroller.scrollTop = Math.max(0, prevTop - step);
        await settle();
        items = await realign(snapshot());
        m = merge(items);
        if (!m.overlap) {
          const jumpedTop = scroller.scrollTop;
          const jumped = items;
          const found = await seekDown(jumpedTop, step);
          if (found) {
            items = found;
            m = merge(items);
          }
          if (!found || !m.added) {
            // 往下找回来了却没有新内容：回到跳过去的位置，照 1.1 的办法先存下来（会标记可能的缺口）
            scroller.scrollTop = jumpedTop;
            await settle();
            items = snapshot();
            m = merge(items);
            if (!m.overlap) items = jumped;
          }
        }
        if (!m.overlap) m = { added: forcePrepend(items), overlap: true };
      }
      lastItems = items;
      lastH = scroller.scrollHeight;

      if (rescueUsed && order.length === countBefore) {
        if (++rescueFails >= 3 && !rescueOff) {
          rescueOff = true;
          log('补位没有带来新内容，改用旧办法继续往上扫。');
        }
      } else if (order.length > countBefore) rescueFails = 0;

      // 既没有读到新消息、也没有离底部更远，就算这一步没有进展
      if (order.length > countBefore || fromBottom() > maxFromBottom + 1) noProgress = 0;
      else noProgress++;
      maxFromBottom = Math.max(maxFromBottom, fromBottom());
      if (fromBottom() <= 2 && prevTop - step > 0 && scroller.scrollHeight - scroller.clientHeight > step * 3) bounced++;
      else bounced = 0;
      if (bounced >= 3) {
        aborted = '页面不断自动跳回底部（会话可能正在输出）';
        break;
      }
      if (noProgress >= 3) {
        // 网络慢、或页面在后台时，更早的消息加载得慢：连着几步没有进展，就多等一会儿再滚
        await sleep(Math.min(CFG.STUCK_WAIT_MAX_MS, 500 * (noProgress - 2)));
        if (document.hidden && noProgress === 3) log('这个标签页好像不在前台：请把它切回来、别最小化，浏览器会在后台暂停加载。');
      }
      if (noProgress >= CFG.STUCK_STEPS) {
        aborted = '连续滚了很多步都没有读到新内容（页面可能卡住了）';
        break;
      }

      if (steps % CFG.LOG_EVERY === 0) {
        const oldest = recs.get(order[0]);
        const pos = oldest && oldest.dataIndex != null && totalRows ? `，已扫到第 ${oldest.dataIndex} 行（共约 ${totalRows} 行）` : '';
        log(`已向上扫 ${steps} 步，收集 ${order.length} 条${pos}${old ? '，还没遇到上次备份的内容' : ''}。`);
      }
    }

    // 回到最底部，页面恢复原样
    for (let i = 0; i < 6; i++) {
      scroller.scrollTop = scroller.scrollHeight;
      await settle();
      if (fromBottom() <= 2) break;
    }

    // ---------- 整理结果 ----------
    // 相邻且内容相同的无编号行只留一条
    order = order.filter((id, i) => {
      if (i === 0) return true;
      const a = recs.get(order[i - 1]);
      const b = recs.get(id);
      return !(!a.key && !b.key && a.fp === b.fp);
    });
    if (boundary) boundary = findBoundary(reachedTop); // 行号可能因上面的整理而变化，重新定位一次

    const all = order.map((id) => recs.get(id));
    const oldestIndex = all.length ? all[0].dataIndex : null;
    const startConfirmed = reachedTop && all.some((r) => r.dataIndex === 0);
    const warnings = [];
    let mode;
    let label;
    let saved = [];
    const counts = { saved: 0, new: 0, sameTextAsOld: 0, updated: 0, oldSkipped: 0, oldOutOfOrder: 0 };

    if (old && boundary) {
      mode = 'incremental';
      label = boundary.by === 'id' ? 'incremental' : 'incremental-CONTENT-MATCH';
      const after = all.slice(boundary.index + 1);
      // 旧文件末尾有没有「在页面上找不到编号」的消息（例如当时还在输出，后来编号变了）
      let lostTail = [];
      if (old.type === 'v2' && boundary.by === 'id') {
        const at = old.tail.findIndex((a) => a.id === all[boundary.index].id);
        if (at >= 0) lostTail = old.tail.slice(at + 1).filter((a) => !recs.has(a.id));
      }
      const lostFps = new Set(lostTail.map((a) => a.fp));
      for (const r of after) {
        const m = matchOf(r);
        if (m.id) {
          counts.oldOutOfOrder++; // 编号在旧文件里，却出现在分界之后：不算新增
          continue;
        }
        r.status = 'new';
        if (boundary.by === 'text' ? m.text : lostFps.has(r.fp)) {
          r.sameTextAsOld = true;
          counts.sameTextAsOld++;
        }
        counts.new++;
        saved.push(r);
      }
      if (lostTail.length) {
        warnings.push(
          `上次备份末尾有 ${lostTail.length} 条消息的编号在页面上找不到了（可能当时还在输出，后来编号变了）。` +
            '所以新增的开头几条可能和上次备份的最后几条内容重复，已尽量标记出来。'
        );
      }
      const before = all.slice(0, boundary.index + 1);
      counts.oldSkipped = before.length;
      if (old.type === 'v2') {
        const upd = before.filter((r) => r.key && r.seenInView && old.fpById.has(r.id) && old.fpById.get(r.id) !== r.fp);
        for (const r of upd) r.status = 'updated';
        counts.updated = upd.length;
        counts.oldSkipped -= upd.length;
        saved = upd.concat(saved);
      }
      if (boundary.by === 'text') {
        warnings.push(
          '新旧分界是靠「连续多条内容与旧文件相同」推断出来的，不是靠消息编号确认的（旧文件里没有编号）。' +
            '一般是准的，但不如编号可靠。下次请选这次存的 JSON，就能按编号确认。'
        );
      }
      if (boundary.run < (boundary.by === 'id' ? CFG.RUN_ID : CFG.RUN_TEXT)) {
        warnings.push(`旧文件里能对上的消息只有 ${boundary.run} 条（已扫到会话开头），分界可信度较低。`);
      }
      if (counts.oldOutOfOrder) {
        warnings.push(`有 ${counts.oldOutOfOrder} 条旧文件里已有的消息出现在分界之后（顺序异常），它们没有被算作新增。`);
      }
      if (counts.sameTextAsOld) {
        warnings.push(
          `新增里有 ${counts.sameTextAsOld} 条的文字和旧文件中的某条完全相同（多半是重复出现的句子），已在文件里标记，请留意。`
        );
      }
      if (counts.updated) {
        warnings.push(`有 ${counts.updated} 条旧消息的内容和上次不一样（例如上次备份时还没输出完），已重新保存并标为「有变化」。`);
      }
    } else if (old) {
      saved = all;
      if (reachedTop) {
        mode = 'full-rescan';
        label = 'FULL-rescan-NOT-incremental';
        for (const r of saved) r.status = 'rescanned';
        warnings.push(
          '没能在页面上找到所选旧文件的结尾，所以无法区分新旧。本次已从最新一直重扫到会话开头，保存的是「全部内容」，不是「新增」。' +
            '下次备份时请选这次存的 JSON，就能真正只存新内容。'
        );
      } else {
        mode = 'partial-unconfirmed';
        label = 'PARTIAL-unconfirmed';
        for (const r of saved) r.status = 'unconfirmed';
        warnings.push(
          '扫描提前结束，而且没有找到所选旧文件的结尾。本文件只是「从最新往回的一段」，其中新旧无法区分，也不完整。不能当作增量备份使用。'
        );
      }
    } else {
      saved = all;
      if (reachedTop) {
        mode = 'full';
        label = 'full';
        for (const r of saved) r.status = 'full';
      } else {
        mode = 'partial';
        label = 'PARTIAL';
        for (const r of saved) r.status = 'partial';
        warnings.push('扫描提前结束，本文件只包含从最新往回的一段，不是完整备份。');
      }
    }
    if (aborted) warnings.push(`扫描中途停止，原因：${aborted}。`);
    if (stopRequested && !boundary && !reachedTop) warnings.push('扫描被你手动停止。');
    if (reachedTop && !startConfirmed && mode !== 'incremental') {
      warnings.push('页面已滚到顶，但无法确认那就是会话的第一条（最早一行的行号不是 0）。更早的内容可能没有加载出来。');
    }
    if (gaps) {
      warnings.push(
        `扫描中有 ${gaps} 处前后没有接上，这些位置可能漏了消息（文件里已标记）。` +
          (mode === 'incremental'
            ? '增量备份一旦漏了，以后的增量也补不回来：建议这次改做一次完整备份（选文件时点「取消」）。'
            : '建议稍后重新做一次完整备份。')
      );
    }
    const neverInView = saved.filter((r) => !r.seenInView).length;
    if (neverInView) warnings.push(`有 ${neverInView} 条消息只在屏幕外被读到，内容可能没有完全显示出来。`);
    if (streamingAtRun) warnings.push('备份时最后一条消息还在输出，保存的可能不是完整版本。下次增量备份会把它重新保存。');
    counts.saved = saved.length;

    const boundaryConfirmed = mode === 'incremental' && boundary.by === 'id' && boundary.run >= CFG.RUN_ID;
    // 记下最新若干条的编号，供下次定位；这次扫到的太少时，把旧文件里记的也带上
    const scannedTail = all.filter((r) => r.key).map((r) => ({ id: r.id, fp: r.fp }));
    const scannedIds = new Set(scannedTail.map((a) => a.id));
    const carried = old && old.type === 'v2' && mode === 'incremental' ? old.tail.filter((a) => !scannedIds.has(a.id)) : [];
    const tailAnchor = carried.concat(scannedTail).slice(-CFG.TAIL_ANCHOR);
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    if (gaps || aborted) label += '-GAPS';
    const base = `cc-session-${session.pathHash}-${stamp}-${label}`;

    const data = {
      format: FORMAT,
      tool: 'cc-session-backup.js ' + VERSION,
      createdAt: now.toISOString(),
      session,
      run: {
        mode,
        boundaryBy: boundary ? boundary.by : null,
        boundaryConfirmed,
        reachedStart: reachedTop,
        startConfirmed,
        stoppedByUser: stopRequested,
        aborted,
        steps,
        durationSec: Math.round((performance.now() - t0) / 1000),
        rowsOnPage: totalRows,
        oldestRowScanned: oldestIndex,
        gaps,
        streamingAtRun,
      },
      previous: old ? { fileName: old.name, type: old.type, createdAt: old.createdAt, count: old.count } : null,
      counts,
      warnings,
      tailAnchor,
      records: saved.map((r) => ({
        id: r.id,
        key: r.key,
        keys: r.keys,
        status: r.status,
        kindGuess: r.kindGuess,
        time: r.time,
        dataIndex: r.dataIndex,
        fp: r.fp,
        streaming: r.streaming || undefined,
        sameTextAsOld: r.sameTextAsOld || undefined,
        possibleGapAfter: r.gapAfter || undefined,
        seenInView: r.seenInView ? undefined : false,
        text: r.text,
        html: r.html,
      })),
    };

    // ---------- 离线 HTML ----------
    const MODE_TEXT = {
      incremental: boundaryConfirmed ? '增量备份：只包含上次备份之后的新内容（已按消息编号确认分界）' : '增量备份：分界未按编号确认，请看下面的提醒',
      'full-rescan': '完整重扫：这不是增量备份，新旧没有区分',
      'partial-unconfirmed': '不完整的重扫：新旧没有区分，也不完整',
      full: '完整备份',
      partial: '不完整的备份',
    };
    const STATUS_TEXT = { new: '新增', updated: '有变化', rescanned: '重扫', unconfirmed: '未确认', full: '', partial: '' };
    const KIND_TEXT = { user: '用户', assistant: 'Claude', other: '其他' };
    const ok = (boundaryConfirmed || mode === 'full') && !gaps && !aborted;
    const html =
      '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      `<title>${esc(session.title || '会话备份')} · ${esc(stamp)}</title><style>` +
      ':root{--bg:#faf9f5;--fg:#1f1e1d;--mu:#6b6a66;--ln:#e3e1d9;--card:#fff;--user:#eef3fb;--ok:#e7f5ec;--okb:#2e7d4f;--wn:#fff4d6;--wnb:#a56a00;--code:#f1efe8}' +
      '@media(prefers-color-scheme:dark){:root{--bg:#1b1a19;--fg:#ecebe6;--mu:#a09e97;--ln:#3a3835;--card:#242321;--user:#232b38;--ok:#1d3326;--okb:#7fd3a0;--wn:#3a2f12;--wnb:#f0c060;--code:#2c2b28}}' +
      '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}' +
      '.wrap{max-width:860px;margin:0 auto;padding:20px 16px 60px}h1{font-size:20px;margin:0 0 6px}.meta{color:var(--mu);font-size:13px;margin:2px 0;overflow-wrap:anywhere}' +
      '.banner{border-radius:8px;padding:10px 14px;margin:14px 0;font-weight:600}.banner.ok{background:var(--ok);color:var(--okb)}.banner.warn{background:var(--wn);color:var(--wnb)}' +
      '.warns{background:var(--wn);color:var(--wnb);border-radius:8px;padding:10px 14px 10px 32px;margin:0 0 14px}.warns li{margin:4px 0}' +
      '.rec{background:var(--card);border:1px solid var(--ln);border-radius:8px;margin:10px 0;padding:10px 14px;overflow-wrap:anywhere}.rec.user{background:var(--user)}' +
      '.hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--mu);margin-bottom:4px}.who{font-weight:700;color:var(--fg)}' +
      '.badge{border:1px solid currentColor;border-radius:999px;padding:0 8px}.badge.new{color:var(--okb)}.badge.warn{color:var(--wnb)}.gap{color:var(--wnb);font-size:13px;text-align:center;margin:6px 0}' +
      '.bd p{margin:.5em 0}.bd pre{background:var(--code);padding:10px;border-radius:6px;overflow-x:auto;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre}' +
      '.bd code{background:var(--code);border-radius:4px;padding:1px 4px;font:13px ui-monospace,Menlo,Consolas,monospace}.bd pre code{background:none;padding:0}' +
      '.bd table{border-collapse:collapse;display:block;overflow-x:auto}.bd td,.bd th{border:1px solid var(--ln);padding:4px 8px}.bd .btn{color:var(--mu)}.bd .img{color:var(--mu)}.bd a{color:inherit}' +
      '</style></head><body><div class="wrap">' +
      `<h1>${esc(session.title || 'Claude Code 会话备份')}</h1>` +
      `<p class="meta">备份时间：${esc(now.toLocaleString())}　共 ${saved.length} 条</p>` +
      `<p class="meta">会话地址：${esc(session.url)}</p>` +
      (old ? `<p class="meta">对比的上次备份：${esc(old.name)}</p>` : '') +
      `<div class="banner ${ok ? 'ok' : 'warn'}">${esc(MODE_TEXT[mode])}</div>` +
      (warnings.length ? '<ul class="warns">' + warnings.map((w) => `<li>${esc(w)}</li>`).join('') + '</ul>' : '') +
      saved
        .map((r) => {
          const st = STATUS_TEXT[r.status];
          return (
            `<article class="rec ${r.kindGuess}">` +
            '<div class="hd">' +
            `<span class="who">${KIND_TEXT[r.kindGuess]}</span>` +
            (st ? `<span class="badge ${r.status === 'new' ? 'new' : 'warn'}">${st}</span>` : '') +
            (r.sameTextAsOld ? '<span class="badge warn">文字与旧备份中某条相同</span>' : '') +
            (r.streaming ? '<span class="badge warn">备份时还在输出</span>' : '') +
            (r.time ? `<span>${esc(r.time)}</span>` : '') +
            (r.dataIndex != null ? `<span>第 ${r.dataIndex} 行</span>` : '') +
            '</div>' +
            `<div class="bd">${r.html || esc(r.text)}</div></article>` +
            (r.gapAfter ? '<div class="gap">⚠ 这里前后没有接上，可能漏了几条</div>' : '')
          );
        })
        .join('\n') +
      '</div></body></html>\n';

    // ---------- 保存（只在本机生成文件） ----------
    const download = (name, text, type) => {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = document.createElement('a'); // 不放进页面
      a.href = url;
      a.download = name;
      a.dispatchEvent(new MouseEvent('click'));
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    };
    const jsonText = JSON.stringify(data, null, 1);
    const save = async () => {
      download(base + '.json', jsonText, 'application/json');
      await sleep(900);
      download(base + '.html', html, 'text/html');
      log(`已保存两个文件：${base}.json 和 ${base}.html`);
    };
    window.ccSave = save;
    await save();

    // ---------- 总结 ----------
    const sec = data.run.durationSec;
    if (mode === 'incremental') {
      if (boundaryConfirmed) log(`✅ 已按消息编号确认新旧分界。新增 ${counts.new} 条${counts.updated ? `，有变化 ${counts.updated} 条` : ''}。`);
      else warn(`找到了分界，但不是按编号确认的。新增（待你留意）${counts.new} 条。`);
      log(`只向上扫了 ${steps} 步（到第 ${oldestIndex != null ? oldestIndex : '?'} 行就停了），用时 ${sec} 秒，没有从头滚。`);
    } else if (mode === 'full') {
      log(`✅ 完整备份完成，共 ${saved.length} 条，用时 ${sec} 秒。下次备份时选这次的 JSON，就只会存新内容。`);
    } else {
      warn(`这次不是增量备份（${MODE_TEXT[mode]}）。共保存 ${saved.length} 条，没有任何一条被标为「新增」。`);
    }
    for (const w of warnings) warn(w);
    log('如果浏览器没有弹出下载，请输入 ccSave() 回车再存一次。');
    result = {
      mode,
      boundaryBy: data.run.boundaryBy,
      boundaryConfirmed,
      counts,
      steps,
      oldestRowScanned: oldestIndex,
      rowsOnPage: totalRows,
      warnings: warnings.length,
      files: [base + '.json', base + '.html'],
    };
    return result;
  } catch (e) {
    warn('出错了，什么都没有保存：', e && e.message ? e.message : e);
    console.error(e);
  } finally {
    delete window.ccStop;
  }
})();
