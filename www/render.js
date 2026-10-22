'use strict';

/*
 * Energy flow, day values and day chart - runs in the browser, no libraries.
 * Used by the adapter's own page (/flow) and copied into ioBroker.smartview (keep in sync).
 *
 *   const f = EnergyView.flow(el);  f.update(snapshot, view)  animated flow (built once, then only updated)
 *     view: {shape: round|square, line: dots|dash|solid, anim: auto|on|off, icons: {pv, grid, battery, house}}
 *   EnergyView.stats(el, summary, battery)                today's values
 *   EnergyView.chart(el, day)                             5-minute curve of a day, touch/hover shows values
 *
 * snapshot: {pv, grid (+ import), battery (+ charge), soc, house, consumers: [{id, name, icon, w}]}
 */

const EnergyView = (() => {
  const ICON = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    grid: '<path d="M12 2 7 22M12 2l5 20M8.5 9h7M7.5 13h9M6.5 17h11M4 6h16M12 2v4"/>',
    battery: '<rect x="6" y="4" width="12" height="18" rx="2"/><path d="M10 2h4M13 9l-3 4h4l-3 4"/>',
    house: '<path d="M3 11 12 3l9 8M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    car: '<path d="M5 16V11l2-5h10l2 5v5M3 16h18v3H3zM7 19v2M17 19v2"/><circle cx="7.5" cy="13.5" r="1"/><circle cx="16.5" cy="13.5" r="1"/>',
    heatpump: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="10" cy="12" r="4"/><path d="M10 8v8M6 12h8M17 9h1M17 12h1M17 15h1"/>',
    water: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
    plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>',
    pool: '<path d="M2 18c2 0 2-1.5 4-1.5S8 18 10 18s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5M8 15V5a2 2 0 0 1 4 0M14 15V5a2 2 0 0 1 4 0M8 9h6M8 12h6"/>',
    heat: '<path d="M4 6v12M8 6v12M12 6v12M16 6v12M20 6v12M3 18h18M3 8h18"/>',
    light: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
    other: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    panel: '<path d="M4 4h16l2 11H2zM8.5 4l-1 11M15.5 4l1 11M3 9.5h18M12 15v4M8 21h8"/>',
    roof: '<path d="M2 12 12 4l10 8M5 10v10h14V10"/><path d="M8 13l2-3h4l2 3z"/>',
    inverter: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 9c1.3-1.6 2.7-1.6 4 0s2.7 1.6 4 0M8 15h8"/>',
    meter: '<rect x="4" y="3" width="16" height="18" rx="2"/><rect x="7" y="6" width="10" height="5" rx="1"/><path d="M9 15h.01M12 15h.01M15 15h.01M9 18h6"/>',
    pylon: '<path d="M8 22 12 2l4 20M9.5 15h5M10.3 10h3.4M5 6h14M6 6l-1 3M18 6l1 3"/>',
    wallbox: '<rect x="6" y="2" width="10" height="14" rx="2"/><path d="M11 6l-2 3h4l-2 3M11 16v3a3 3 0 0 0 6 0v-6l2-2"/>',
    boiler: '<rect x="6" y="2" width="12" height="18" rx="5"/><path d="M12 8s2 2.2 2 3.6a2 2 0 0 1-4 0C10 10.2 12 8 12 8zM9 22h6"/>',
    ac: '<rect x="2" y="5" width="20" height="9" rx="2"/><path d="M6 11h12M7 17c0 1.5-1 2-1 3M12 17v3M17 17c0 1.5 1 2 1 3"/>',
    washer: '<rect x="4" y="2" width="16" height="20" rx="2"/><circle cx="12" cy="13" r="5"/><path d="M7 5h2M14 5h3"/>',
    kitchen: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M4 9h16"/><circle cx="9" cy="5.5" r="1"/><circle cx="15" cy="5.5" r="1"/><rect x="7" y="12" width="10" height="6" rx="1"/>',
    server: '<rect x="4" y="3" width="16" height="7" rx="1.5"/><rect x="4" y="14" width="16" height="7" rx="1.5"/><path d="M8 6.5h.01M8 17.5h.01"/>',
    pump: '<circle cx="9" cy="13" r="6"/><path d="M15 13h6M18 9v8M9 13l3-3M6 21h6"/>',
    tv: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    factory: '<path d="M2 21V10l6 4V10l6 4V4h4v17zM2 21h20M6 17h2M11 17h2M16 17h2"/>',
  };
  const COLOR = { pv: '#f5b700', import: '#e5484d', export: '#30a46c', battery: '#12a594', consumer: '#8e7cf0' };
  const R = 30;

  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /** 850 W, 4,2 kW */
  function fmtW(w) {
    if (w === null || w === undefined || !Number.isFinite(w)) return '–';
    const a = Math.abs(w);
    if (a < 1000) return Math.round(w) + ' W';
    return (w / 1000).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: a < 10000 ? 2 : 1 }) + ' kW';
  }

  function fmtKwh(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '–';
    return v.toLocaleString('de-DE', { minimumFractionDigits: v < 100 ? 1 : 0, maximumFractionDigits: v < 10 ? 2 : 1 }) + ' kWh';
  }

  /** seconds for one dot step: faster with more power */
  function speed(w) {
    return Math.max(0.3, Math.min(2.4, 3.2 - Math.log10(Math.max(w, 10)) * 0.8));
  }

  function icon(name, x, y, size) {
    const k = size / 24;
    return '<g class="ef-ic" transform="translate(' + (x - size / 2) + ' ' + (y - size / 2) + ') scale(' + k + ')">' + (ICON[name] || ICON.other) + '</g>';
  }

  /** Positions of all nodes; the house in the middle, consumers in a row below. */
  /** layout of the nodes; `view.icons` replaces the symbols of PV, grid, battery and house */
  function layout(s, view) {
    const ic = (view && view.icons) || {};
    const n = (s.consumers || []).length;
    const h = n ? 330 : 230;
    const nodes = [
      { key: 'pv', x: 180, y: 50, icon: ic.pv || 'sun', label: 'PV' },
      { key: 'house', x: 180, y: 165, icon: ic.house || 'house', label: 'Haus' },
    ];
    if (s.grid !== null && s.grid !== undefined) nodes.push({ key: 'grid', x: 48, y: 165, icon: ic.grid || 'grid', label: 'Netz' });
    if (s.battery !== null && s.battery !== undefined) nodes.push({ key: 'battery', x: 312, y: 165, icon: ic.battery || 'battery', label: 'Batterie' });
    (s.consumers || []).forEach((c, i) => {
      const x = n === 1 ? 180 : 40 + (280 / (n - 1)) * i;
      nodes.push({ key: 'c_' + c.id, x, y: 285, icon: c.icon, label: c.name, consumer: true, r: n > 5 ? 22 : 26 });
    });
    return { nodes, h };
  }

  /** line from the edge of node a to the edge of node b */
  function line(a, b, square) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    // a square reaches further along a diagonal
    const k = square ? 1 / Math.max(Math.abs(dx / d), Math.abs(dy / d)) : 1;
    const ra = (a.r || R) * k + 4;
    const rb = (b.r || R) * k + 4;
    return 'M' + (a.x + (dx / d) * ra).toFixed(1) + ' ' + (a.y + (dy / d) * ra).toFixed(1) + ' L' + (b.x - (dx / d) * rb).toFixed(1) + ' ' + (b.y - (dy / d) * rb).toFixed(1);
  }

  function flow(el) {
    let shape = '';
    let parts = {};

    function build(s, view) {
      const v = view || {};
      const sq = v.shape === 'square';
      const { nodes, h } = layout(s, v);
      const house = nodes.find(n => n.key === 'house');
      const cls = ['ef-flow', 'ef-line-' + (['dash', 'solid'].includes(v.line) ? v.line : 'dots'), 'ef-anim-' + (['auto', 'off'].includes(v.anim) ? v.anim : 'on')];
      let svg = '<svg class="' + cls.join(' ') + '" viewBox="0 0 360 ' + h + '" role="img" aria-label="Energiefluss">';
      for (const n of nodes) {
        if (n.key === 'house') continue;
        // drawn from the node to the house; the animation direction says which way it flows
        const d = n.consumer ? line(house, n, sq) : line(n, house, sq);
        svg += '<path class="ef-base" d="' + d + '"/><path class="ef-dots" data-line="' + esc(n.key) + '" d="' + d + '"/>';
      }
      for (const n of nodes) {
        const r = n.r || R;
        svg += '<g class="ef-node ef-' + (n.consumer ? 'consumer' : n.key) + '" data-node="' + esc(n.key) + '">';
        const shapeAt = (cls, rr, extra) =>
          sq
            ? '<rect class="' + cls + '" x="' + (n.x - rr) + '" y="' + (n.y - rr) + '" width="' + 2 * rr + '" height="' + 2 * rr + '" rx="' + Math.round(rr * 0.28) + '"' + extra + '/>'
            : '<circle class="' + cls + '" cx="' + n.x + '" cy="' + n.y + '" r="' + rr + '"' + extra + '/>';
        svg += shapeAt('ef-bg', r, '');
        // charge level as a ring along the outline (pathLength 100 = percent)
        if (n.key === 'battery') svg += shapeAt('ef-soc', r + 0.5, ' pathLength="100" stroke-dasharray="0 100"' + (sq ? '' : ' transform="rotate(-90 ' + n.x + ' ' + n.y + ')"'));
        svg += icon(n.icon, n.x, n.y - (n.consumer ? 7 : 9), n.consumer ? 16 : 20);
        svg += '<text class="ef-val" x="' + n.x + '" y="' + (n.y + (n.consumer ? 12 : 15)) + '" data-val></text>';
        const ly = n.key === 'pv' ? n.y - r - 8 : n.y + r + 15;
        // the house needs no label (the lines to the consumers would cross it)
        svg += '<text class="ef-lbl" x="' + n.x + '" y="' + ly + '" data-lbl>' + (n.key === 'house' ? '' : esc(n.label)) + '</text></g>';
      }
      svg += '</svg>';
      el.innerHTML = svg;
      parts = {};
      el.querySelectorAll('[data-line]').forEach(p => (parts['l_' + p.dataset.line] = p));
      el.querySelectorAll('[data-node]').forEach(g => (parts['n_' + g.dataset.node] = g));
    }

    function setLine(key, w, inward, color) {
      const p = parts['l_' + key];
      if (!p) return;
      const on = w >= 10;
      p.style.visibility = on ? 'visible' : 'hidden';
      if (!on) return;
      p.style.stroke = color;
      p.style.animationDuration = speed(w).toFixed(2) + 's';
      p.style.animationDirection = inward ? 'normal' : 'reverse';
    }

    function setNode(key, text, label, cls) {
      const g = parts['n_' + key];
      if (!g) return;
      g.querySelector('[data-val]').textContent = text;
      if (label !== undefined) g.querySelector('[data-lbl]').textContent = label;
      if (cls !== undefined) g.setAttribute('class', 'ef-node ef-' + (key.startsWith('c_') ? 'consumer' : key) + (cls ? ' ' + cls : ''));
    }

    function update(s, view) {
      const key = [s.grid !== null && s.grid !== undefined, s.battery !== null && s.battery !== undefined, (s.consumers || []).map(c => c.id + c.icon + c.name).join(), JSON.stringify(view || {})].join('|');
      if (key !== shape) {
        shape = key;
        build(s, view);
      }
      setLine('pv', s.pv, true, COLOR.pv);
      setNode('pv', fmtW(s.pv), undefined, s.pv >= 10 ? 'active' : '');
      if (s.grid !== null && s.grid !== undefined) {
        const imp = s.grid > 0;
        setLine('grid', Math.abs(s.grid), imp, imp ? COLOR.import : COLOR.export);
        setNode('grid', fmtW(Math.abs(s.grid)), Math.abs(s.grid) < 10 ? 'Netz' : imp ? 'Netzbezug' : 'Einspeisung', Math.abs(s.grid) < 10 ? '' : imp ? 'import' : 'export');
      }
      if (s.battery !== null && s.battery !== undefined) {
        setLine('battery', Math.abs(s.battery), s.battery < 0, COLOR.battery);
        const what = Math.abs(s.battery) < 10 ? 'Batterie' : s.battery > 0 ? 'lädt' : 'entlädt';
        setNode('battery', fmtW(Math.abs(s.battery)), s.soc !== null && s.soc !== undefined ? what + ' · ' + s.soc + ' %' : what, Math.abs(s.battery) >= 10 ? 'active' : '');
        const ring = parts.n_battery && parts.n_battery.querySelector('.ef-soc');
        if (ring) ring.setAttribute('stroke-dasharray', (s.soc === null || s.soc === undefined ? 0 : s.soc) + ' 100');
      }
      setNode('house', fmtW(s.house));
      for (const c of s.consumers || []) {
        setLine('c_' + c.id, c.w, false, COLOR.consumer);
        setNode('c_' + c.id, fmtW(c.w), undefined, c.w >= 10 ? 'active' : '');
      }
    }

    return { update };
  }

  /** Today's values as cards. */
  function stats(el, t, withBattery) {
    if (!t) {
      el.innerHTML = '';
      return;
    }
    const pct = v => (v === null || v === undefined ? '–' : v + ' %');
    const cards = [
      ['sun', 'Erzeugt', fmtKwh(t.pv), 'pv'],
      ['house', 'Verbraucht', fmtKwh(t.house), ''],
      ['grid', 'Bezogen', fmtKwh(t.import), 'import'],
      ['grid', 'Eingespeist', fmtKwh(t.export), 'export'],
      ['other', 'Autarkie', pct(t.autarky), 'pct'],
      ['sun', 'Eigenverbrauch', pct(t.selfUse), 'pct'],
    ];
    if (withBattery) cards.push(['battery', 'Geladen', fmtKwh(t.charge), 'battery'], ['battery', 'Entladen', fmtKwh(t.discharge), 'battery']);
    el.innerHTML = '<div class="ef-stats">' + cards.map(c => '<div class="ef-card ' + c[3] + '"><svg viewBox="0 0 24 24" class="ef-cic">' + ICON[c[0]] + '</svg><span class="ef-ct">' + c[1] + '</span><b>' + c[2] + '</b></div>').join('') + '</div>';
  }

  /** Day curve: PV (area), consumption (line), battery charge level (dashed, right axis). */
  function chart(el, day) {
    const pts = (day && day.points) || [];
    const W = 640;
    const H = 220;
    const L = 40;
    const B = 22;
    const T = 10;
    const Rr = 34;
    const max = Math.max(1000, ...pts.map(p => Math.max(p.pv, p.house))) * 1.1;
    const t0 = new Date(day && day.date ? day.date + 'T00:00:00' : Date.now()).setHours(0, 0, 0, 0);
    const x = t => L + ((t - t0) / 86400000) * (W - L - Rr);
    const y = w => T + (1 - w / max) * (H - T - B);
    const ys = s => T + (1 - s / 100) * (H - T - B);
    const hasSoc = pts.some(p => p.soc !== undefined);
    let svg = '<svg class="ef-chart" viewBox="0 0 ' + W + ' ' + H + '">';
    const step = max > 8000 ? 2000 : max > 4000 ? 1000 : 500;
    for (let v = 0; v <= max; v += step) {
      svg += '<line class="ef-gridline" x1="' + L + '" x2="' + (W - Rr) + '" y1="' + y(v) + '" y2="' + y(v) + '"/><text class="ef-ax" x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + (v / 1000).toLocaleString('de-DE') + '</text>';
    }
    for (let hh = 0; hh <= 24; hh += 3) {
      svg += '<text class="ef-ax" x="' + x(t0 + hh * 3600000) + '" y="' + (H - 5) + '" text-anchor="middle">' + hh + '</text>';
    }
    svg += '<text class="ef-ax" x="' + (L - 6) + '" y="' + (T - 1) + '" text-anchor="end">kW</text>';
    if (hasSoc) svg += '<text class="ef-ax" x="' + (W - Rr + 6) + '" y="' + (ys(100) + 4) + '">100%</text><text class="ef-ax" x="' + (W - Rr + 6) + '" y="' + (ys(0) + 4) + '">0%</text>';
    if (pts.length > 1) {
      const path = k => pts.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p[k]).toFixed(1)).join(' ');
      svg += '<path class="ef-pvarea" d="' + path('pv') + ' L' + x(pts[pts.length - 1].t).toFixed(1) + ' ' + y(0) + ' L' + x(pts[0].t).toFixed(1) + ' ' + y(0) + ' Z"/>';
      svg += '<path class="ef-pvline" d="' + path('pv') + '"/><path class="ef-houseline" d="' + path('house') + '"/>';
      const soc = pts.filter(p => p.soc !== undefined);
      if (soc.length > 1) svg += '<path class="ef-socline" d="' + soc.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + ys(p.soc).toFixed(1)).join(' ') + '"/>';
    } else {
      svg += '<text class="ef-ax" x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle">Noch keine Werte für diesen Tag</text>';
    }
    svg += '<line class="ef-cursor" x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '" visibility="hidden"/></svg>';
    svg += '<div class="ef-legend"><span class="pv">PV</span><span class="house">Verbrauch</span>' + (hasSoc ? '<span class="soc">Ladestand</span>' : '') + '<span class="ef-tip"></span></div>';
    el.innerHTML = svg;
    const s = el.querySelector('svg');
    const cur = el.querySelector('.ef-cursor');
    const tip = el.querySelector('.ef-tip');
    const show = e => {
      if (!pts.length) return;
      const r = s.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      let best = pts[0];
      for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
      cur.setAttribute('x1', x(best.t));
      cur.setAttribute('x2', x(best.t));
      cur.setAttribute('visibility', 'visible');
      const d = new Date(best.t);
      tip.textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + '  PV ' + fmtW(best.pv) + ' · Verbrauch ' + fmtW(best.house) + (best.soc !== undefined ? ' · ' + best.soc + ' %' : '');
    };
    s.addEventListener('pointermove', show);
    s.addEventListener('pointerdown', show);
    s.addEventListener('pointerleave', () => {
      cur.setAttribute('visibility', 'hidden');
      tip.textContent = '';
    });
  }

  const css = [
    '.ef-flow{width:100%;height:auto;display:block;font-family:inherit}',
    '.ef-base{stroke:var(--ef-line,rgba(127,127,127,.25));stroke-width:3;fill:none}',
    '.ef-dots{fill:none;stroke-width:6;stroke-linecap:round;stroke-dasharray:0 14;animation:ef-run 1s linear infinite;visibility:hidden}',
    '.ef-line-dash .ef-dots{stroke-width:4;stroke-dasharray:10 8;animation-name:ef-run2}',
    '.ef-line-solid .ef-dots{stroke-width:4;stroke-dasharray:none;animation-name:ef-pulse;animation-direction:alternate!important}',
    '@keyframes ef-run{to{stroke-dashoffset:-28}}@keyframes ef-run2{to{stroke-dashoffset:-36}}@keyframes ef-pulse{from{opacity:1}to{opacity:.35}}',
    // "auto" follows the device setting "reduce motion"; "on" always runs; "off" shows still lines
    '@media (prefers-reduced-motion:reduce){.ef-anim-auto .ef-dots{animation:none;stroke-dasharray:none;stroke-width:3}}',
    '.ef-anim-off .ef-dots{animation:none;stroke-dasharray:none;stroke-width:3}',
    '.ef-bg{fill:var(--ef-node,rgba(127,127,127,.12));stroke:var(--ef-line,rgba(127,127,127,.35));stroke-width:2}',
    '.ef-ic{fill:none;stroke:var(--ef-muted,#888);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
    '.ef-val{font-size:12px;font-weight:700;text-anchor:middle;fill:var(--ef-fg,currentColor)}',
    '.ef-consumer .ef-val{font-size:10.5px}',
    '.ef-lbl{font-size:11px;text-anchor:middle;fill:var(--ef-muted,#888)}',
    '.ef-pv.active .ef-bg{stroke:#f5b700}.ef-pv.active .ef-ic{stroke:#f5b700}',
    '.ef-grid.import .ef-bg,.ef-grid.import .ef-ic{stroke:#e5484d}.ef-grid.export .ef-bg,.ef-grid.export .ef-ic{stroke:#30a46c}',
    '.ef-battery .ef-soc{fill:none;stroke:#12a594;stroke-width:4;stroke-linecap:round}',
    '.ef-battery.active .ef-ic{stroke:#12a594}',
    '.ef-house .ef-bg{stroke:var(--ef-accent,#4c8dff);stroke-width:2.5}.ef-house .ef-ic{stroke:var(--ef-accent,#4c8dff)}',
    '.ef-consumer.active .ef-bg,.ef-consumer.active .ef-ic{stroke:#8e7cf0}',
    '.ef-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}',
    '.ef-card{background:var(--ef-node,rgba(127,127,127,.12));border-radius:12px;padding:9px 11px;display:grid;grid-template-columns:20px 1fr;gap:2px 8px;align-items:center}',
    '.ef-card b{grid-column:1/3;font-size:18px;font-variant-numeric:tabular-nums}',
    '.ef-ct{font-size:12px;color:var(--ef-muted,#888)}',
    '.ef-cic{width:18px;height:18px;fill:none;stroke:var(--ef-muted,#888);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
    '.ef-card.pv .ef-cic{stroke:#f5b700}.ef-card.import .ef-cic{stroke:#e5484d}.ef-card.export .ef-cic{stroke:#30a46c}.ef-card.battery .ef-cic{stroke:#12a594}',
    '.ef-chart{width:100%;height:auto;display:block;touch-action:pan-y}',
    '.ef-gridline{stroke:var(--ef-line,rgba(127,127,127,.2));stroke-width:1}',
    '.ef-ax{font-size:11px;fill:var(--ef-muted,#888)}',
    '.ef-pvarea{fill:rgba(245,183,0,.25)}.ef-pvline{fill:none;stroke:#f5b700;stroke-width:2}',
    '.ef-houseline{fill:none;stroke:var(--ef-accent,#4c8dff);stroke-width:2}',
    '.ef-socline{fill:none;stroke:#12a594;stroke-width:1.5;stroke-dasharray:4 3}',
    '.ef-cursor{stroke:var(--ef-muted,#888);stroke-width:1}',
    '.ef-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--ef-muted,#888);margin-top:4px}',
    '.ef-legend span.pv:before,.ef-legend span.house:before,.ef-legend span.soc:before{content:"";display:inline-block;width:12px;height:3px;margin-right:5px;vertical-align:middle;background:#f5b700}',
    '.ef-legend span.house:before{background:var(--ef-accent,#4c8dff)}.ef-legend span.soc:before{background:#12a594}',
    '.ef-tip{margin-left:auto;color:var(--ef-fg,currentColor);font-variant-numeric:tabular-nums}',
  ].join('\n');

  return { flow, stats, chart, fmtW, fmtKwh, css, ICON };
})();

if (typeof module !== 'undefined') module.exports = EnergyView;
