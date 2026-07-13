'use strict';

const { Plugin, Notice } = require('obsidian');

const SVGNS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;

// イベント種別ごとの色（ライト/ダーク両対応の固定色）
const TYPE_STYLE = {
  '締切': { color: '#e5534b', label: '締切' },
  '面接': { color: '#4c8dff', label: '面接/予定' },
  '発表': { color: '#3fb950', label: '発表' },
};

module.exports = class ShukatsuTimelinePlugin extends Plugin {
  async onload() {
    // ```shukatsu-timeline``` コードブロックをタイムライン描画に置き換える
    this.registerMarkdownCodeBlockProcessor('shukatsu-timeline', (source, el) => {
      try {
        this.renderBlock(el, this.parseOptions(source));
      } catch (e) {
        el.createEl('pre', { text: '就活タイムライン描画エラー: ' + (e && e.message) });
      }
    });

    // 幅・サイズ調整用のCSSを注入（total ページの cssclass: wide-page で横幅いっぱいに）
    this.injectStyles();

    // ステータスバー：直近の締切/発表の件数
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addEventListener('click', () => this.alertUpcoming(true));

    // 手動でアラートを出すコマンド
    this.addCommand({
      id: 'shukatsu-alert',
      name: '就活：直近の締切/発表をアラート表示',
      callback: () => this.alertUpcoming(true),
    });

    // メタデータ準備後に起動時アラート＋ステータスバー更新
    this.app.workspace.onLayoutReady(() => {
      this.updateStatusBar();
      this.alertUpcoming(false);
      // 企業ノートの変更を検知してステータスバー更新
      this.registerEvent(this.app.metadataCache.on('changed', () => this.updateStatusBar()));
    });
  }

  // 幅とSVGサイズ用のCSSを注入
  injectStyles() {
    const style = document.createElement('style');
    style.id = 'shukatsu-timeline-style';
    style.textContent = [
      // cssclass: wide-page のノートは「読みやすい行の長さ」を解除して全幅に
      '.markdown-preview-view.wide-page .markdown-preview-sizer,',
      '.markdown-source-view.mod-cm6.wide-page .cm-sizer { max-width: none !important; }',
      '.shukatsu-tl svg { width: 100%; height: auto; display: block; }',
    ].join('\n');
    document.head.appendChild(style);
    this.register(() => style.remove());
  }

  // ---- オプション解析 ----
  parseOptions(source) {
    const opts = { folder: '就活/企業', past: 7, future: 120, months: 0, weeks: 0, range: '', alert: 7 };
    for (const line of (source || '').split('\n')) {
      const m = line.match(/^\s*([^:]+):\s*(.+?)\s*$/);
      if (!m) continue;
      const k = m[1].trim();
      const v = m[2].trim();
      if (k === 'folder') opts.folder = v;
      else if (k === 'past') opts.past = this.parseSpan(v) || opts.past;      // 日数 or 2w/1m など
      else if (k === 'future') opts.future = parseInt(v) || opts.future;
      else if (k === 'months') opts.months = parseFloat(v) || opts.months;
      else if (k === 'weeks') opts.weeks = parseFloat(v) || opts.weeks;
      else if (k === 'range') opts.range = v;                                 // 例: 2w / 10d / 3m / 1y
      else if (k === 'alert') opts.alert = parseInt(v) || opts.alert;
    }
    return opts;
  }

  // "2w" "10d" "3m" "1y" → 日数に換算（単位なしは日数）
  parseSpan(v) {
    const m = String(v).match(/^\s*(\d+(?:\.\d+)?)\s*([dwmy]?)\s*$/i);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    switch ((m[2] || 'd').toLowerCase()) {
      case 'w': return n * 7;
      case 'm': return n * 30;
      case 'y': return n * 365;
      default: return n;
    }
  }

  // n ヶ月後の日付
  addMonths(d, n) {
    const whole = Math.trunc(n);
    const x = new Date(d.getFullYear(), d.getMonth() + whole, d.getDate());
    const frac = n - whole;
    if (frac) x.setDate(x.getDate() + Math.round(frac * 30));
    return x;
  }

  // オプションから軸の右端(end)を決める。優先度: range > months > weeks > future(auto)
  computeEnd(today, opts, events) {
    if (opts.range) {
      const m = String(opts.range).match(/^\s*(\d+(?:\.\d+)?)\s*([dwmy]?)\s*$/i);
      if (m && (m[2] || '').toLowerCase() === 'm') return this.addMonths(today, parseFloat(m[1]));
      const days = this.parseSpan(opts.range);
      if (days) return new Date(today.getTime() + days * DAY);
    }
    if (opts.months) return this.addMonths(today, opts.months);
    if (opts.weeks) return new Date(today.getTime() + opts.weeks * 7 * DAY);
    // 自動：最後のイベント＋5日（future日を上限、最低14日）
    const maxEv = events.reduce((a, e) => (e.date > a ? e.date : a), today);
    let end = new Date(maxEv.getTime() + 5 * DAY);
    const cap = new Date(today.getTime() + opts.future * DAY);
    if (end > cap) end = cap;
    const minEnd = new Date(today.getTime() + 14 * DAY);
    if (end < minEnd) end = minEnd;
    return end;
  }

  // ---- 日付ユーティリティ ----
  dayOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return this.dayOnly(v);
    const m = String(v).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  daysFromToday(d) { return Math.round((this.dayOnly(d) - this.dayOnly(new Date())) / DAY); }

  // ---- 企業ノートからイベント収集 ----
  collectEvents(folder) {
    const events = [];
    const files = this.app.vault.getMarkdownFiles().filter(f =>
      f.path === folder || f.path.startsWith(folder + '/'));
    for (const f of files) {
      const fm = this.app.metadataCache.getFileCache(f) && this.app.metadataCache.getFileCache(f).frontmatter;
      if (!fm) continue;
      if (fm.type && fm.type !== '企業') continue;
      const company = fm['会社名'] || f.basename;
      const status = fm['選考状況'] || '';
      const done = /内定|お祈り|辞退/.test(status); // 完了案件は締切アラート対象外
      const add = (val, type, detail) => {
        const d = this.toDate(val);
        if (d) events.push({ company, file: f, date: d, type, detail: detail || TYPE_STYLE[type].label, status, done });
      };
      add(fm['締切'], '締切', 'エントリー/ES締切');
      add(fm['次回日程'], '面接', fm['次回内容'] || '次の予定');
      add(fm['発表日'], '発表', '合否発表');
    }
    return events;
  }

  // ---- ステータスバー更新 ----
  updateStatusBar() {
    if (!this.statusEl) return;
    const up = this.collectEvents('就活/企業')
      .filter(e => !e.done)
      .map(e => ({ ...e, days: this.daysFromToday(e.date) }))
      .filter(e => e.days >= 0 && e.days <= 7)
      .sort((a, b) => a.days - b.days);
    if (up.length === 0) { this.statusEl.setText(''); return; }
    const nearest = up[0];
    const when = nearest.days === 0 ? '今日' : `あと${nearest.days}日`;
    this.statusEl.setText(`⏰ 就活 ${up.length}件 (最短 ${when})`);
    this.statusEl.title = up.map(e => `${e.days === 0 ? '今日' : 'あと' + e.days + '日'}：${e.company}（${e.detail}）`).join('\n');
  }

  // ---- アラート（Notice）----
  alertUpcoming(always) {
    const up = this.collectEvents('就活/企業')
      .filter(e => !e.done)
      .map(e => ({ ...e, days: this.daysFromToday(e.date) }))
      .filter(e => e.days >= 0 && e.days <= 7)
      .sort((a, b) => a.days - b.days);
    if (up.length === 0) {
      if (always) new Notice('就活：直近7日の締切/発表はありません 👍');
      return;
    }
    const lines = up.map(e => {
      const when = e.days === 0 ? '⚠️今日' : `あと${e.days}日`;
      return `${when}｜${e.company}｜${e.type}（${e.detail}）`;
    });
    new Notice('⏰ 就活アラート（7日以内）\n' + lines.join('\n'), always ? 12000 : 10000);
  }

  // ---- コードブロック本体（タイムライン＋アラート＋一覧）----
  renderBlock(el, opts) {
    el.empty();
    const root = el.createDiv({ cls: 'shukatsu-tl' });
    root.style.setProperty('--muted', 'var(--text-muted)');

    const events = this.collectEvents(opts.folder)
      .map(e => ({ ...e, days: this.daysFromToday(e.date) }));

    if (events.length === 0) {
      root.createEl('p', {
        text: `「${opts.folder}」に日付つきの企業ノートがありません。締切 / 次回日程 / 発表日 のプロパティを入れてください。`,
      }).style.color = 'var(--text-muted)';
      return;
    }

    this.renderAlertBar(root, events, opts.alert);
    this.renderGantt(root, events, opts);
    this.renderUpcomingList(root, events);
  }

  // 上部アラートバー
  renderAlertBar(root, events, within) {
    const soon = events
      .filter(e => !e.done && e.days >= 0 && e.days <= within)
      .sort((a, b) => a.days - b.days);
    const bar = root.createDiv();
    Object.assign(bar.style, {
      display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center',
      padding: '10px 12px', borderRadius: '10px', marginBottom: '12px',
      border: '1px solid var(--background-modifier-border)',
      background: soon.length ? 'rgba(229,83,75,0.10)' : 'var(--background-secondary)',
    });
    const head = bar.createEl('strong', { text: soon.length ? `⏰ ${within}日以内の締切・発表：${soon.length}件` : `✅ ${within}日以内の締切・発表はありません` });
    head.style.marginRight = '4px';
    for (const e of soon) {
      const chip = bar.createSpan();
      Object.assign(chip.style, {
        display: 'inline-flex', gap: '6px', alignItems: 'center',
        padding: '3px 9px', borderRadius: '999px', fontSize: '12px', cursor: 'pointer',
        background: 'var(--background-primary)', border: `1px solid ${TYPE_STYLE[e.type].color}`,
      });
      const dot = chip.createSpan();
      Object.assign(dot.style, { width: '8px', height: '8px', borderRadius: '50%', background: TYPE_STYLE[e.type].color });
      chip.createSpan({ text: `${e.days === 0 ? '今日' : 'あと' + e.days + '日'}｜${e.company}｜${e.type}` });
      chip.onclick = () => this.app.workspace.openLinkText(e.file.path, '', false);
    }
  }

  // ガント風タイムライン（SVG）
  renderGantt(root, events, opts) {
    const today = this.dayOnly(new Date());
    let start = new Date(today.getTime() - opts.past * DAY);
    const end = this.computeEnd(today, opts, events);
    // 範囲外のイベントはタイムラインから除外（アラート・直近リストは別途全件対象）
    events = events.filter(e => e.date >= start && e.date <= end);
    if (events.length === 0) {
      root.createEl('p', { text: 'この期間に締切/面接/発表はありません。`months` を増やすと先の予定まで表示します。' })
        .style.color = 'var(--text-muted)';
      return;
    }
    const minEv = events.reduce((a, e) => (e.date < a ? e.date : a), start);
    if (minEv < start) start = new Date(minEv.getTime() - 2 * DAY);
    const span = Math.max(1, (end - start) / DAY);

    // 企業ごとに行をまとめ、直近イベント日で並べる
    const byCompany = new Map();
    for (const e of events) {
      if (!byCompany.has(e.company)) byCompany.set(e.company, { company: e.company, file: e.file, events: [] });
      byCompany.get(e.company).events.push(e);
    }
    const rows = [...byCompany.values()].sort((a, b) => {
      const na = Math.min(...a.events.filter(e => e.days >= 0).map(e => e.days).concat([9999]));
      const nb = Math.min(...b.events.filter(e => e.days >= 0).map(e => e.days).concat([9999]));
      return na - nb;
    });

    const W = 1000, labelW = 170, padR = 24, axisH = 48, rowH = 64;
    const H = axisH + rows.length * rowH + 24;
    const plotW = W - labelW - padR;
    const xFor = d => labelW + ((this.dayOnly(d) - start) / DAY / span) * plotW;

    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', '100%');
    svg.style.maxWidth = '100%';
    svg.style.font = '12px var(--font-interface, sans-serif)';
    root.appendChild(svg);

    const mk = (tag, attrs, parent) => {
      const n = document.createElementNS(SVGNS, tag);
      for (const k in attrs) {
        const v = attrs[k];
        // var() はSVGの属性では解決されないため style プロパティ経由で指定する
        if (typeof v === 'string' && v.indexOf('var(') !== -1) n.style.setProperty(k, v);
        else n.setAttribute(k, v);
      }
      (parent || svg).appendChild(n);
      return n;
    };

    // 月グリッド＋ラベル
    const cur = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cur <= end) {
      const x = xFor(cur);
      if (x >= labelW - 1) {
        mk('line', { x1: x, y1: axisH - 8, x2: x, y2: H - 10, stroke: 'var(--background-modifier-border)', 'stroke-width': 1 });
        const t = mk('text', { x: x + 4, y: 18, fill: 'var(--text-muted)', 'font-size': 14 });
        t.textContent = `${cur.getMonth() + 1}月`;
      }
      cur.setMonth(cur.getMonth() + 1);
    }

    // 今日ライン
    const tx = xFor(today);
    mk('line', { x1: tx, y1: axisH - 14, x2: tx, y2: H - 10, stroke: 'var(--interactive-accent)', 'stroke-width': 2.5, 'stroke-dasharray': '5 3' });
    const tl = mk('text', { x: tx + 4, y: 34, fill: 'var(--interactive-accent)', 'font-size': 13, 'font-weight': 'bold' });
    tl.textContent = '今日';

    // 各行
    rows.forEach((row, i) => {
      const y = axisH + i * rowH + rowH / 2;
      // ベースライン
      mk('line', { x1: labelW, y1: y, x2: W - padR, y2: y, stroke: 'var(--background-modifier-border)', 'stroke-width': 1 });
      // 企業名（クリックでノートを開く）
      const name = row.company.length > 11 ? row.company.slice(0, 11) + '…' : row.company;
      const label = mk('text', { x: 4, y: y + 5, fill: 'var(--text-normal)', 'font-size': 15, 'font-weight': '600', cursor: 'pointer' });
      label.textContent = name;
      label.style.textDecoration = 'underline';
      label.onclick = () => this.app.workspace.openLinkText(row.file.path, '', false);
      const ttl = document.createElementNS(SVGNS, 'title');
      ttl.textContent = row.company;
      label.appendChild(ttl);

      // イベント点
      const sorted = [...row.events].sort((a, b) => a.date - b.date);
      sorted.forEach((e, j) => {
        const x = xFor(e.date);
        const col = TYPE_STYLE[e.type].color;
        const faded = e.done || e.days < 0;
        const g = mk('g', {});
        g.style.opacity = faded ? '0.4' : '1';
        g.style.cursor = 'pointer';
        g.onclick = () => this.app.workspace.openLinkText(e.file.path, '', false);
        mk('circle', { cx: x, cy: y, r: 8, fill: col, stroke: 'var(--background-primary)', 'stroke-width': 2 }, g);
        // 日付ラベルを点の上下交互に
        const up = j % 2 === 0;
        const lt = mk('text', { x: x, y: up ? y - 15 : y + 24, fill: 'var(--text-muted)', 'font-size': 12, 'text-anchor': 'middle' }, g);
        const mm = String(e.date.getMonth() + 1), dd = String(e.date.getDate());
        lt.textContent = `${mm}/${dd}`;
        const t2 = document.createElementNS(SVGNS, 'title');
        t2.textContent = `${row.company}｜${e.type}（${e.detail}）｜${e.date.getFullYear()}/${mm}/${dd}｜${e.days === 0 ? '今日' : e.days > 0 ? 'あと' + e.days + '日' : Math.abs(e.days) + '日前'}`;
        g.appendChild(t2);
      });
    });

    // 凡例
    const legend = root.createDiv();
    Object.assign(legend.style, { display: 'flex', gap: '14px', margin: '6px 0 4px', fontSize: '12px', color: 'var(--text-muted)' });
    for (const key of Object.keys(TYPE_STYLE)) {
      const item = legend.createSpan();
      Object.assign(item.style, { display: 'inline-flex', alignItems: 'center', gap: '5px' });
      const d = item.createSpan();
      Object.assign(d.style, { width: '10px', height: '10px', borderRadius: '50%', background: TYPE_STYLE[key].color });
      item.createSpan({ text: TYPE_STYLE[key].label });
    }
  }

  // 直近イベント一覧
  renderUpcomingList(root, events) {
    const upcoming = events.filter(e => e.days >= 0).sort((a, b) => a.days - b.days).slice(0, 12);
    if (upcoming.length === 0) return;
    const box = root.createDiv();
    box.style.marginTop = '10px';
    box.createEl('div', { text: '📌 直近の予定' }).style.cssText = 'font-weight:600;margin-bottom:6px;';
    const ul = box.createEl('ul');
    ul.style.cssText = 'margin:0;padding-left:2px;list-style:none;';
    for (const e of upcoming) {
      const li = ul.createEl('li');
      li.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 0;cursor:pointer;';
      const badge = li.createSpan({ text: e.days === 0 ? '今日' : `あと${e.days}日` });
      badge.style.cssText = `min-width:60px;text-align:center;font-size:11px;padding:2px 6px;border-radius:6px;color:#fff;background:${e.days <= 3 ? '#e5534b' : e.days <= 7 ? '#d99a00' : 'var(--background-modifier-border)'};`;
      const dot = li.createSpan();
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${TYPE_STYLE[e.type].color};`;
      li.createSpan({ text: `${e.company}｜${e.type}（${e.detail}）` });
      const dstr = `${e.date.getMonth() + 1}/${e.date.getDate()}`;
      const dsp = li.createSpan({ text: dstr });
      dsp.style.cssText = 'color:var(--text-muted);font-size:11px;margin-left:auto;';
      li.onclick = () => this.app.workspace.openLinkText(e.file.path, '', false);
    }
  }
};
