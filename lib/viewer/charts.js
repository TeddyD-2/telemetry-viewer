import uPlot from 'uplot';
import {
  indexWindow, describe, finiteRange, histogram, medianStep, welch, polyfit, resampleOnto,
} from './analysis.js';
import { RAMP, rampIndex, tint, withAlpha } from './palette.js';
import { openChartMenu, closeChartMenu, chartMenuFor } from './chartMenu.js';

/* The chart workspace, on uPlot.

   This was the trace stack: one kind of chart, a channel against time. It is now a
   workspace of charts of several kinds -- line, XY scatter, histogram, spectrum and a
   statistics table -- each configured on its own (x axis, scale, style, bins, fit...)
   from the settings button in its header. What was the Analysis view is simply charts of
   those kinds sitting in the same grid as the traces, sharing the cursor and the zoom
   window, rather than a separate page that could only show one of each.

   uPlot stays. The line charts are its home ground -- long ordered series, a cursor
   synchronised across two dozen live canvases -- and nothing heavier does that as well.
   The other kinds use it for axes, scales, zoom and sizing, and draw their own marks
   where uPlot's model does not fit (a scatter is not an ordered series).

   A chart has a stable id, assigned when it is made. Charts used to be keyed by the
   channels they held, which meant an elaborate guess about which DOM node a merged or
   split chart "was". With an id, a change keeps every chart it did not touch, moves the
   nodes that moved, and animates them from where they were to where they are.

   Imported sessions: every chart shows the same channel from each session opened
   alongside this one, lighter and dashed on line charts, as its own series elsewhere.
   How a session is matched and aligned is the viewer's business (compare.js); this only
   asks for the columns. */

const DRAG_SLOP = 5;
const EDGE = 56;

export const CHART_TYPES = [
  { type: 'line',  label: 'Line',       hint: 'channels against time or distance' },
  { type: 'xy',    label: 'XY scatter', hint: 'one channel against another' },
  { type: 'hist',  label: 'Histogram',  hint: 'how the samples are distributed' },
  { type: 'fft',   label: 'Spectrum',   hint: 'frequency content, by FFT' },
  { type: 'stats', label: 'Statistics', hint: 'min, max, mean, percentiles, per window or per lap' },
];
const TYPE_LABEL = Object.fromEntries(CHART_TYPES.map(t => [t.type, t.label]));

const DEFAULTS = {
  line:  () => ({ x: 'auto', style: 'line', axes: 'independent',
                  y: { mode: 'auto', min: '', max: '', log: false }, refs: '', laps: true, stats: false }),
  xy:    () => ({ xChan: -1, colorBy: -1, range: 'view', fit: 0, equal: false, rings: false, size: 2,
                  connect: false, xr: null, yr: null }),
  hist:  () => ({ bins: 40, norm: 'pct', cumulative: false, range: 'view' }),
  fft:   () => ({ seg: 1024, logX: false, logY: true, range: 'view' }),
  stats: () => ({ group: 'window', range: 'view' }),
};

let seq = 0;
export function newChart(type, chans, extra = {}){
  return { id: 'c' + (++seq) + Math.random().toString(36).slice(2, 6), type, chans: chans.slice(),
    h: 0, wide: false, overlays: true, ...DEFAULTS[type](), ...extra };
}
/* Changing a chart's kind keeps what it already had -- its channels, height, and any
   settings the two kinds share -- and fills in the rest. */
export function retype(c, type){
  const d = DEFAULTS[type]();
  for (const k of Object.keys(d)) if (!(k in c)) c[k] = d[k];
  c.type = type;
}

export function createCharts(ctx){
  /* ctx: { D, fmtD, esc, note, download, maxPlotted, chanColor, isMath, channelList,
            xOf(mode), xFmtFor(mode), viewFor(mode), setViewFrom(mode, range|null),
            hover(idx, fromPlot), compare() -> [{S, key, name, dash}], colIn(S, ci),
            overlayColumn(s, ci, mode), win(all) -> [i0,i1], swin(S, all) -> [i0,i1],
            sessSig(), lapSets(ci), removeFrom(chart, ci), editChannel(ci), onChanged() } */
  const views = new Map();
  let wrap = null, viewRoot = null, lastLayout = '', bar = null, dragEndedAt = 0;

  const ro = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(entries => {
        for (const e of entries){
          const v = [...views.values()].find(x => x.body === e.target);
          if (!v || !v.plot) continue;
          const w = Math.max(120, Math.round(e.contentRect.width));
          if (w !== v.plot.width) v.plot.setSize({ width: w, height: heightOf(v.chart) });
        }
      })
    : null;

  const heightOf = c => c.h || ctx.D.traceH;
  const xModeOf = c => (c.x && c.x !== 'auto' ? c.x : ctx.D.xMode);
  const winKey = c => (c.range === 'all' ? 'all' : `${ctx.D.xMode}:${ctx.D.view[0]}:${ctx.D.view[1]}`);
  const verOf = ci => `${ci}:${ctx.D.colVer[ci] || 0}`;

  function destroyPlot(v){
    if (v.plot){ v.plot.destroy(); v.plot = null; }
    v.body.innerHTML = '';
    v.state = {};
  }
  function dropView(v){
    if (ro) ro.unobserve(v.body);
    destroyPlot(v);
    v.cell.remove();
  }
  function destroyAll(){
    closeChartMenu();
    for (const v of views.values()) dropView(v);
    views.clear();
    wrap = null; bar = null; lastLayout = '';
  }

  function render(root){
    const { D } = ctx;
    viewRoot = root;
    if (!D.charts.length){
      destroyAll();
      root.className = '';
      root.innerHTML = `<div class="hint empty-traces">
        <b>Nothing plotted yet.</b>
        <div>Click channels in the sidebar, or drag them in. <b class="inl">+ Chart</b> in the
          toolbar adds a scatter, histogram, spectrum or statistics table. Drag a chart by its
          header to move it, or onto another chart to overlay the two.</div>
        <div class="keys"><kbd>drag</kbd> zoom <kbd>wheel</kbd> zoom
          <kbd>double-click</kbd> reset <kbd>M</kbd> marker at the cursor
          <kbd>ƒ Math</kbd> build a channel from others</div>
      </div>`;
      return;
    }
    if (!wrap || wrap.parentNode !== root){
      destroyAll();
      root.innerHTML = '';
      root.className = '';
      wrap = document.createElement('div');
      root.appendChild(wrap);
    }
    wrap.className = `lanes cols-${D.traceCols}`;

    const ids = D.charts.map(c => c.id);
    const layout = ids.join(',') + '|' + D.traceCols + '|' + D.charts.map(c => (c.wide ? 1 : 0)).join('');
    const structural = layout !== lastLayout;
    const before = structural && lastLayout ? measure() : null;
    lastLayout = layout;
    if (structural) reconcile(ids, !!before);
    if (chartMenuFor() && !D.charts.includes(chartMenuFor())) closeChartMenu();

    D.charts.forEach((c, i) => {
      const v = views.get(c.id);
      v.chart = c; v.idx = i;
      v.cell.classList.toggle('wide', !!c.wide);
      const T = TYPES[c.type];
      const hs = headSig(c);
      if (v.hsig !== hs){ buildHeader(v); v.hsig = hs; }
      const s = T.sig(c);
      if (v.sig !== s){
        destroyPlot(v);
        try { T.build(v, c); }
        catch (err){ v.body.innerHTML = `<div class="hint chart-msg">This chart could not be drawn: ${ctx.esc(err.message || err)}</div>`; }
        v.sig = s;
      }
      applyHeight(v);
      if (T.sync && (v.plot || c.type === 'stats')) T.sync(v, c);
    });
    syncCursor(null);
    if (before) flip(before);
  }

  function reconcile(ids, animate){
    for (const [id, v] of views) if (!ids.includes(id)){ dropView(v); views.delete(id); }
    for (const id of ids) if (!views.has(id)) views.set(id, makeView(id, animate));
    ids.forEach((id, i) => {
      const v = views.get(id);
      if (wrap.children[i] !== v.cell) wrap.insertBefore(v.cell, wrap.children[i] || null);
    });
  }

  function makeView(id, fresh){
    const cell = document.createElement('div');
    cell.className = 'lane' + (fresh ? ' enter' : '');
    cell.dataset.id = id;
    const hd = document.createElement('div');
    hd.className = 'lane-hd';
    const body = document.createElement('div');
    body.className = 'lane-body';
    cell.append(hd, body);
    const v = { id, cell, hd, body, plot: null, sig: '', hsig: '', idx: -1, chart: null, state: {} };
    addGrip(v);
    attachLaneDrag(v);
    hd.onclick = e => onHeaderClick(v, e);
    if (ro) ro.observe(body);
    cell.addEventListener('animationend', () => cell.classList.remove('enter'));
    return v;
  }

  function applyHeight(v){
    const h = heightOf(v.chart);
    if (v.chart.type === 'stats'){ v.body.style.maxHeight = h + 'px'; return; }
    v.body.style.maxHeight = '';
    if (v.plot && v.plot.height !== h) v.plot.setSize({ width: v.plot.width, height: h });
  }

  /* ---- motion: FLIP ---- */
  function measure(){
    const m = new Map();
    for (const v of views.values()) if (v.cell.isConnected) m.set(v.cell, v.cell.getBoundingClientRect());
    return m;
  }
  function flip(before){
    if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const v of views.values()){
      const b = before.get(v.cell);
      if (!b) continue;
      const a = v.cell.getBoundingClientRect();
      const dx = b.left - a.left, dy = b.top - a.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      const c = v.cell;
      c.style.transition = 'none';
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      c.getBoundingClientRect();
      c.style.transition = '';
      c.style.transform = '';
    }
  }

  /* ================================ header ================================ */

  function headSig(c){
    return [c.type, c.chans.join('+'), c.xChan, c.overlays && ctx.sessSig(), c.stats, ctx.D.notesVer,
      c.chans.map(ci => ctx.D.label[ci]).join('|'), c.chans.map(ctx.chanColor).join()].join('/');
  }

  function buildHeader(v){
    const c = v.chart, { D, esc, chanColor, isMath } = ctx;
    const multi = c.chans.length > 1;
    const sessions = c.overlays ? ctx.compare() : [];
    const chip = ci => `<span class="ser" data-ci="${ci}"
        title="${multi ? 'drag to pull this channel out' : 'drag to move this chart'}">
        <span class="sw" style="background:${chanColor(ci)}"></span>
        ${isMath(ci) ? '<button class="fx" data-edit title="edit math channel">ƒ</button>' : ''}
        <span class="nm" title="${esc(ctx.tipFor(ci))}">${esc(D.label[ci])}</span>
        <span class="u">${esc(D.units[ci] || '')}</span>
        ${c.type === 'line' || c.type === 'xy' ? '<span class="v"></span>' : ''}
        ${c.type === 'line' ? sessions.filter(s => ctx.colIn(s.S, ci)).map(s =>
          `<span class="ov" data-key="${s.key}" title="${esc(s.name)}"><i style="border-color:${tint(chanColor(ci), .35)}"></i><b></b></span>`).join('') : ''}
        ${c.type === 'line' && c.stats ? '<span class="st"></span>' : ''}
        <button class="drop" title="remove ${esc(D.label[ci])} from this chart">×</button>
      </span>`;
    let html = c.chans.map(chip).join('');
    if (c.type === 'xy'){
      const x = c.xChan;
      html += `<span class="vs">vs</span><span class="xch">${x >= 0
        ? `<span class="nm">${esc(D.label[x])}</span><span class="u">${esc(D.units[x] || '')}</span><span class="v"></span>`
        : '<button class="linky" data-cfg>choose an X channel</button>'}</span><span class="read"></span>`;
    }
    if (c.type === 'hist' || c.type === 'fft') html += '<span class="read"></span>';
    html += `<span class="tools"><span class="kind">${TYPE_LABEL[c.type]}</span>
      <button class="cfg" data-cfg title="Chart settings" aria-label="Chart settings">
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h7M13 4h1M2 8h2M8 8h6M2 12h8M14 12h0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="11" cy="4" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="12" cy="12" r="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>
      </button><span class="grab" title="drag to move, or onto another chart to overlay">⠿</span></span>`;
    v.hd.className = 'lane-hd' + (multi ? ' merged' : '');
    v.hd.innerHTML = html;
  }

  function onHeaderClick(v, e){
    if (performance.now() - dragEndedAt < 250) return;
    if (e.target.closest('[data-cfg]')){
      e.stopPropagation();
      openMenu(v);
      return;
    }
    const ser = e.target.closest('.ser');
    if (!ser) return;
    if (e.target.closest('.drop')){ e.stopPropagation(); ctx.removeFrom(v.chart, +ser.dataset.ci); }
    else if (e.target.closest('[data-edit]')){ e.stopPropagation(); ctx.editChannel(+ser.dataset.ci); }
  }

  function openMenu(v){
    openChartMenu({
      anchor: v.hd.querySelector('.cfg'),
      chart: v.chart,
      ctx,
      types: CHART_TYPES,
      retype,
      onChange: () => ctx.onChanged(),
      actions: {
        duplicate: () => {
          const { D } = ctx;
          const copy = JSON.parse(JSON.stringify(v.chart));
          copy.id = newChart(copy.type, []).id;
          D.charts.splice(D.charts.indexOf(v.chart) + 1, 0, copy);
          ctx.onChanged();
        },
        png: v.chart.type === 'stats' ? null : () => savePng(v),
        csv: () => saveCsv(v),
        resetZoom: () => {
          const c = v.chart;
          if (c.type === 'xy'){ c.xr = c.yr = null; TYPES.xy.sync(v, c, true); }
          else if (c.type === 'line'){ c.y.mode = c.y.mode === 'fixed' ? 'auto' : c.y.mode; ctx.setViewFrom(xModeOf(c), null); }
          else { v.sig = ''; ctx.onChanged(); }
        },
        remove: () => {
          const { D } = ctx;
          D.charts = D.charts.filter(x => x !== v.chart);
          closeChartMenu();
          ctx.onChanged();
        },
      },
    });
  }

  function fmtV(v, ci){
    return ctx.fmtD(v, 2);
  }

  /* Cursor moved: every chart shows it, except the one whose own hover moved it. */
  function syncCursor(fromPlot){
    const { D } = ctx;
    for (const v of views.values()){
      const c = v.chart;
      if (!c) continue;
      const T = TYPES[c.type];
      if (T.cursor && v.plot) T.cursor(v, c, v.plot === fromPlot);
      if (c.type === 'line' || c.type === 'xy') updateValues(v, c, D.cursor);
    }
  }

  function updateValues(v, c, i){
    const { D } = ctx;
    const mk = D.marker;
    v.hd.querySelectorAll('.ser').forEach(el => {
      const ci = +el.dataset.ci, col = D.cols[ci];
      const out = el.querySelector('.v');
      if (!out) return;
      const val = col[i];
      out.style.color = ctx.chanColor(ci);
      out.innerHTML = fmtV(val, ci) + (mk >= 0 && mk < D.n
        ? ` <small>Δ${(val - col[mk] >= 0 ? '+' : '') + ctx.fmtD(val - col[mk], 2)}</small>` : '');
      if (c.type === 'line' && v.state.overlays){
        el.querySelectorAll('.ov').forEach(ov => {
          const o = v.state.overlays.find(x => x.ci === ci && x.s.key === ov.dataset.key);
          ov.querySelector('b').textContent = o ? fmtV(v.plot.data[o.k][i], ci) : '—';
        });
      }
    });
    if (c.type === 'xy' && c.xChan >= 0){
      const x = v.hd.querySelector('.xch .v');
      if (x) x.textContent = ctx.fmtD(D.cols[c.xChan][i], 2);
    }
  }

  /* ================================ chart types ================================ */

  const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  const axisBase = () => ({
    stroke: css('--ink-3'),
    grid: { stroke: css('--grid'), width: 1 },
    ticks: { stroke: css('--grid'), width: 1 },
    font: '11px ui-monospace, monospace',
  });
  const fmtAxis = v => ctx.fmtD(v, Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);
  const baseOpts = (v, c) => ({
    width: Math.max(120, v.body.clientWidth || v.cell.clientWidth),
    height: heightOf(c),
    padding: [10, 12, 0, 0],
    legend: { show: false },
  });
  const noData = (v, msg) => { v.body.innerHTML = `<div class="hint chart-msg" style="height:${heightOf(v.chart)}px">${msg}</div>`; };

  /* Every sample set a non-line chart draws: this session's channels, then the same
     channels from each imported session, each over its own window. */
  function sampleSets(c, all){
    const { D } = ctx;
    const sets = [];
    const [i0, i1] = ctx.win(all);
    c.chans.forEach(ci => sets.push({ ci, col: D.cols[ci], t: D.t, i0, i1, color: ctx.chanColor(ci),
      name: D.label[ci], primary: true }));
    if (c.overlays) for (const s of ctx.compare()){
      const [j0, j1] = ctx.swin(s.S, all);
      c.chans.forEach(ci => {
        const col = ctx.colIn(s.S, ci);
        if (col) sets.push({ ci, col, t: s.S.t, i0: j0, i1: j1, color: tint(ctx.chanColor(ci), .4),
          dash: s.dash, name: `${D.label[ci]} · ${s.name}`, s });
      });
    }
    return sets;
  }

  const TYPES = {};

  /* ---------------------------------- line ---------------------------------- */
  TYPES.line = {
    sig: c => ['line', c.chans.map(verOf).join('+'), ctx.D.lineW, xModeOf(c), c.style, c.axes,
      c.y.mode, c.y.min, c.y.max, c.y.log, c.refs, c.laps, c.overlays && ctx.sessSig()].join('|'),

    build(v, c){
      const { D, chanColor } = ctx;
      const mode = xModeOf(c), xs = ctx.xOf(mode);
      if (!xs){ noData(v, 'Distance needs a speed or position channel &mdash; set one under Channel roles.'); return; }
      const shared = c.axes === 'shared' || c.chans.length === 1;
      const scaleOf = n => (shared ? 'y' : 'y' + n);
      const style = c.style;
      const mkPaths = () => (style === 'step' ? uPlot.paths.stepped({ align: 1 })
        : style === 'points' ? () => null : undefined);
      const mkPoints = color => (style === 'points'
        ? { show: true, size: 3, width: 0, fill: color, stroke: color, space: 0 } : { show: false });

      const data = [xs], series = [{}];
      c.chans.forEach((ci, n) => {
        const color = chanColor(ci);
        data.push(D.cols[ci]);
        series.push({ label: D.label[ci], scale: scaleOf(n), stroke: color, width: D.lineW,
          fill: style === 'area' ? withAlpha(color, .13) : undefined,
          paths: mkPaths(), points: mkPoints(color) });
      });
      const overlays = [];
      if (c.overlays) for (const s of ctx.compare()){
        c.chans.forEach((ci, n) => {
          const col = ctx.overlayColumn(s, ci, mode);
          if (!col) return;
          const color = tint(chanColor(ci), .35);
          data.push(col);
          series.push({ label: `${D.label[ci]} · ${s.name}`, scale: scaleOf(n), stroke: color,
            width: D.lineW, dash: s.dash, paths: mkPaths(), points: mkPoints(color) });
          overlays.push({ s, ci, n, k: data.length - 1 });
        });
      }
      v.state.overlays = overlays;
      v.state.mode = mode;

      const [a, b] = ctx.viewFor(mode);
      const scales = { x: { time: false, min: a, max: b } };
      const keys = shared ? ['y'] : c.chans.map((_, n) => 'y' + n);
      for (const k of keys) scales[k] = yScale(c);

      const xfmt = ctx.xFmtFor(mode);
      const axes = [{ ...axisBase(), values: (u, splits) => splits.map(xfmt) }];
      const yAxis = (scale, side, color, grid) => ({
        ...axisBase(), scale, side, size: 54,
        stroke: color || css('--ink-3'),
        grid: grid ? { stroke: css('--grid'), width: 1 } : { show: false },
        values: (u, splits) => splits.map(fmtAxis),
      });
      if (shared) axes.push(yAxis('y', 3, null, true));
      else {
        axes.push(yAxis('y0', 3, chanColor(c.chans[0]), true));
        axes.push(yAxis('y1', 1, chanColor(c.chans[1]), false));
      }

      const refs = String(c.refs || '').split(/[,;\s]+/).map(Number).filter(x => x === x && String(x) !== '');
      const opts = {
        ...baseOpts(v, c),
        cursor: { y: false, drag: { x: true, y: false, setScale: false }, points: { show: false } },
        scales, series, axes,
        hooks: {
          setSelect: [u => {
            if (u.select.width <= 0) return;
            const x0 = u.posToVal(u.select.left, 'x'), x1 = u.posToVal(u.select.left + u.select.width, 'x');
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            ctx.setViewFrom(mode, [Math.min(x0, x1), Math.max(x0, x1)]);
          }],
          setCursor: [u => { if (u.cursor.idx != null) ctx.hover(u.cursor.idx, u); }],
          drawClear: [u => { if (c.laps) drawLapLines(u, mode); }],
          draw: [u => {
            drawRefs(u, refs, shared ? 'y' : 'y0');
            drawMarker(u, xs);
          }],
        },
        plugins: [wheelZoom(c, mode, shared ? 'y' : null)],
      };
      const u = new uPlot(opts, data, v.body);
      u.over.addEventListener('dblclick', () => ctx.setViewFrom(mode, null));
      v.plot = u;
    },

    sync(v, c){
      const u = v.plot;
      const [a, b] = ctx.viewFor(v.state.mode);
      if (u.scales.x.min !== a || u.scales.x.max !== b) u.setScale('x', { min: a, max: b });
      if (v.state.marker !== ctx.D.marker){ v.state.marker = ctx.D.marker; u.redraw(false); }
      if (c.stats){
        const key = `${a}:${b}:${c.chans.map(verOf)}`;
        if (v.state.statsKey !== key){
          v.state.statsKey = key;
          const xs = ctx.xOf(v.state.mode);
          const [i0, i1] = indexWindow(xs, ctx.D.n, a, b);
          v.hd.querySelectorAll('.ser').forEach(el => {
            const col = ctx.D.cols[+el.dataset.ci];
            let mn = Infinity, mx = -Infinity, s = 0, n = 0;
            for (let i = i0; i <= i1; i++){ const x = col[i]; if (x === x){ if (x < mn) mn = x; if (x > mx) mx = x; s += x; n++; } }
            const st = el.querySelector('.st');
            if (st) st.textContent = n ? `min ${ctx.fmtD(mn, 2)} · avg ${ctx.fmtD(s / n, 2)} · max ${ctx.fmtD(mx, 2)}` : '';
          });
        }
      }
    },

    cursor(v, c, own){
      if (own) return;
      const u = v.plot, xs = ctx.xOf(v.state.mode);
      if (!xs) return;
      const left = u.valToPos(xs[ctx.D.cursor], 'x');
      u.setCursor({ left: left >= 0 && left <= u.over.clientWidth ? left : -10, top: 10 }, false);
    },

    csv(v, c){
      const { D } = ctx, mode = v.state.mode, xs = ctx.xOf(mode);
      const [i0, i1] = indexWindow(xs, D.n, ...ctx.viewFor(mode));
      const head = [mode === 'time' ? 'Time (s)' : 'Distance (m)',
        ...c.chans.map(ci => D.names[ci]), ...(v.state.overlays || []).map(o => `${D.names[o.ci]} [${o.s.name}]`)];
      const rows = [];
      for (let i = i0; i <= i1; i++)
        rows.push([xs[i], ...c.chans.map(ci => D.cols[ci][i]), ...(v.state.overlays || []).map(o => v.plot.data[o.k][i])]);
      return { head, rows };
    },
  };

  function yScale(c){
    const y = c.y;
    const fixed = () => {
      const a = parseFloat(y.min), b = parseFloat(y.max);
      return y.mode === 'fixed' && a === a && b === b && b > a ? [a, b] : null;
    };
    if (y.log) return { distr: 3, log: 10, ...(fixed() ? { range: () => fixed() } : {}) };
    return {
      range: (u, min, max) => {
        const f = fixed();
        if (f) return f;
        if (min == null || !(max >= min)) return [0, 1];
        if (y.mode === 'zero'){ min = Math.min(0, min); max = Math.max(0, max); }
        if (!(max > min)){ const m = min || 0; return [m - 1, m + 1]; }
        const pad = (max - min) * 0.08;
        return [y.mode === 'zero' && min === 0 ? 0 : min - pad, y.mode === 'zero' && max === 0 ? 0 : max + pad];
      },
    };
  }

  function drawLapLines(u, mode){
    const { D } = ctx;
    if (!D.laps.length) return;
    const g = u.ctx;
    g.save();
    g.beginPath(); g.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height); g.clip();
    g.strokeStyle = 'rgba(200,16,46,.35)'; g.lineWidth = 1;
    for (const l of D.laps){
      const x = Math.round(u.valToPos(mode === 'time' ? l.t0 : l.d0, 'x', true)) + 0.5;
      g.beginPath(); g.moveTo(x, u.bbox.top); g.lineTo(x, u.bbox.top + u.bbox.height); g.stroke();
    }
    g.restore();
  }
  function drawRefs(u, refs, scale){
    if (!refs.length || !u.scales[scale]) return;
    const g = u.ctx, dpr = devicePixelRatio || 1;
    g.save();
    g.beginPath(); g.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height); g.clip();
    g.strokeStyle = css('--s4'); g.fillStyle = css('--s4'); g.lineWidth = dpr;
    g.setLineDash([6 * dpr, 4 * dpr]);
    g.font = `${10 * dpr}px ui-monospace, monospace`; g.textAlign = 'right'; g.textBaseline = 'bottom';
    for (const r of refs){
      const y = Math.round(u.valToPos(r, scale, true)) + 0.5;
      if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) continue;
      g.beginPath(); g.moveTo(u.bbox.left, y); g.lineTo(u.bbox.left + u.bbox.width, y); g.stroke();
      g.fillText(ctx.fmtD(r, 2), u.bbox.left + u.bbox.width - 4 * dpr, y - 2 * dpr);
    }
    g.restore();
  }
  function drawMarker(u, xs){
    const { D } = ctx;
    if (!(D.marker >= 0) || !xs) return;
    const g = u.ctx, dpr = devicePixelRatio || 1;
    const x = Math.round(u.valToPos(xs[D.marker], 'x', true)) + 0.5;
    if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) return;
    g.save();
    g.strokeStyle = css('--s4'); g.lineWidth = 1.5 * dpr; g.setLineDash([4 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(x, u.bbox.top); g.lineTo(x, u.bbox.top + u.bbox.height); g.stroke();
    g.fillStyle = css('--s4'); g.font = `600 ${10 * dpr}px system-ui`; g.textAlign = 'left'; g.textBaseline = 'top';
    g.fillText('M', x + 3 * dpr, u.bbox.top + 2 * dpr);
    g.restore();
  }

  /* Wheel over the plot zooms time about the pointer. Over the y axis it zooms the
     vertical scale instead, which fixes it -- the settings menu shows it as Fixed, and
     double-clicking the axis puts it back on Auto. */
  function wheelZoom(c, mode, yKey){
    return {
      hooks: {
        ready: [u => {
          u.over.addEventListener('wheel', e => {
            e.preventDefault();
            const rect = u.over.getBoundingClientRect();
            const left = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
            const { min, max } = u.scales.x;
            if (!(max > min)) return;
            const at = u.posToVal(left, 'x');
            if (!(at === at)) return;
            const f = e.deltaY > 0 ? 1.25 : 0.8;
            ctx.setViewFrom(mode, [at - (at - min) * f, at + (max - at) * f]);
          }, { passive: false });
          if (!yKey) return;
          u.root.addEventListener('wheel', e => {
            const or = u.over.getBoundingClientRect();
            if (e.clientX >= or.left || e.clientY < or.top || e.clientY > or.bottom) return;
            e.preventDefault();
            const { min, max } = u.scales[yKey];
            if (!(max > min) || c.y.log) return;
            const at = u.posToVal(e.clientY - or.top, yKey);
            const f = e.deltaY > 0 ? 1.25 : 0.8;
            Object.assign(c.y, { mode: 'fixed', min: +(at - (at - min) * f).toPrecision(6), max: +(at + (max - at) * f).toPrecision(6) });
            ctx.onChanged();
          }, { passive: false });
          u.root.addEventListener('dblclick', e => {
            const or = u.over.getBoundingClientRect();
            if (e.clientX >= or.left) return;
            c.y.mode = 'auto';
            ctx.onChanged();
          });
        }],
      },
    };
  }

  /* ---------------------------------- xy ---------------------------------- */
  /* A scatter is not an ordered series, so uPlot supplies the frame -- axes, scales, box
     zoom, sizing -- and the points are drawn here, straight onto its canvas. Colour-by
     buckets points into the ramp's nine steps so a 36 000-point cloud is nine fills, not
     36 000 style changes. */
  TYPES.xy = {
    sig: c => ['xy', verOf(c.xChan), c.chans.map(verOf).join('+'), c.colorBy >= 0 ? verOf(c.colorBy) : '-',
      c.range, c.fit, c.equal, c.rings, c.size, c.connect, c.overlays && ctx.sessSig()].join('|'),

    build(v, c){
      if (!(c.xChan >= 0)){ noData(v, 'Choose the channel for the X axis in this chart’s settings.'); return; }
      collectXY(v, c);
      const st = v.state;
      const opts = {
        ...baseOpts(v, c),
        cursor: { drag: { x: true, y: true, uni: 24, setScale: false }, points: { show: false }, x: false, y: false },
        scales: { x: { time: false, range: () => st.cur.x }, y: { range: () => st.cur.y } },
        series: [{}, { scale: 'y', paths: () => null, points: { show: false } }],
        axes: [
          { ...axisBase(), values: (u, s) => s.map(fmtAxis) },
          { ...axisBase(), size: 54, values: (u, s) => s.map(fmtAxis) },
        ],
        hooks: {
          ready: [u => applyRanges(v)],
          setSize: [u => { queueMicrotask(() => { if (v.plot === u){ applyRanges(v); sizeCursorCanvas(v); drawXYCursor(v); } }); }],
          drawClear: [u => drawRings(u, c)],
          draw: [u => drawPoints(u, v, c)],
          setSelect: [u => {
            const s = u.select;
            if (s.width < 4 && s.height < 4) return;
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            if (s.width >= 4){
              const a = u.posToVal(s.left, 'x'), b = u.posToVal(s.left + s.width, 'x');
              c.xr = [Math.min(a, b), Math.max(a, b)];
            }
            if (s.height >= 4 && s.height < u.over.clientHeight - 2){
              const a = u.posToVal(s.top + s.height, 'y'), b = u.posToVal(s.top, 'y');
              c.yr = [Math.min(a, b), Math.max(a, b)];
            }
            applyRanges(v);
          }],
        },
      };
      st.cur = { x: st.x, y: st.y };
      const u = new uPlot(opts, [[st.x[0], st.x[1]], [st.y[0], st.y[1]]], v.body);
      v.plot = u;
      const cv = document.createElement('canvas');
      cv.className = 'xy-cur';
      u.over.appendChild(cv);
      st.curCanvas = cv;
      sizeCursorCanvas(v);
      u.over.addEventListener('dblclick', () => { c.xr = c.yr = null; applyRanges(v); });
      let raf = 0, lastE = null;
      u.over.addEventListener('mousemove', e => {
        lastE = e;
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; hoverXY(v, c, lastE); });
      });
    },

    sync(v, c, force){
      const key = winKey(c);
      if (force || v.state.win !== key){
        if (v.state.win !== key) collectXY(v, c);
        applyRanges(v);
      }
    },
    cursor(v){ drawXYCursor(v); },

    csv(v, c){
      const { D } = ctx;
      const [i0, i1] = ctx.win(c.range === 'all');
      const head = [D.names[c.xChan], ...c.chans.map(ci => D.names[ci])];
      const rows = [];
      for (let i = i0; i <= i1; i++) rows.push([D.cols[c.xChan][i], ...c.chans.map(ci => D.cols[ci][i])]);
      return { head, rows };
    },
  };

  function collectXY(v, c){
    const { D } = ctx;
    const st = v.state;
    st.win = winKey(c);
    const all = c.range === 'all';
    const sets = [];
    const add = (xcol, ycol, i0, i1, color, primary, s) => {
      const len = Math.max(0, i1 - i0 + 1), stride = Math.max(1, Math.ceil(len / 60000));
      const m = Math.ceil(len / stride);
      const xs = new Float64Array(m), ys = new Float64Array(m), idx = new Int32Array(m);
      let k = 0;
      for (let i = i0; i <= i1; i += stride){
        const x = xcol[i], y = ycol[i];
        if (x === x && y === y){ xs[k] = x; ys[k] = y; idx[k] = i; k++; }
      }
      sets.push({ xs, ys, idx, n: k, color, primary, s });
    };
    const [i0, i1] = ctx.win(all);
    if (c.overlays) for (const s of ctx.compare()){
      const sx = ctx.colIn(s.S, c.xChan);
      if (!sx) continue;
      const [j0, j1] = ctx.swin(s.S, all);
      c.chans.forEach(ci => { const sy = ctx.colIn(s.S, ci); if (sy) add(sx, sy, j0, j1, tint(ctx.chanColor(ci), .45), false, s); });
    }
    c.chans.forEach(ci => add(D.cols[c.xChan], D.cols[ci], i0, i1, ctx.chanColor(ci), true));
    st.sets = sets;

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of sets) for (let k = 0; k < s.n; k++){
      const x = s.xs[k], y = s.ys[k];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!(x1 >= x0)){ x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
    if (c.rings){
      const lim = Math.max(0.5, Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1)) * 1.05;
      x0 = y0 = -lim; x1 = y1 = lim;
    } else {
      const px = (x1 - x0) * 0.04 || 1, py = (y1 - y0) * 0.04 || 1;
      x0 -= px; x1 += px; y0 -= py; y1 += py;
    }
    st.x = [x0, x1]; st.y = [y0, y1];

    st.color = null;
    if (c.colorBy >= 0){
      const cc = D.cols[c.colorBy];
      const r = finiteRange(cc, i0, i1);
      st.color = r ? { col: cc, lo: r[0], hi: r[1] } : null;
    }

    st.fit = null;
    const first = sets.find(s => s.primary);
    if (c.fit > 0 && first) st.fit = polyfit(first.xs, first.ys, first.n, c.fit);
    const read = v.hd.querySelector('.read');
    if (read){
      read.innerHTML = st.fit ? `<span class="fit">${fitText(st.fit)}</span>` : '';
      if (st.color) read.innerHTML += ` <span class="cb">colour: ${ctx.esc(D.label[c.colorBy])}
        <i style="background:linear-gradient(90deg,${RAMP.join(',')})"></i>${ctx.fmtD(st.color.lo, 1)}–${ctx.fmtD(st.color.hi, 1)}</span>`;
    }
  }

  function fitText(f){
    const terms = [];
    for (let j = f.coef.length - 1; j >= 0; j--){
      const a = f.coef[j];
      const mag = Math.abs(a) >= 1000 || (Math.abs(a) < 0.01 && a !== 0) ? Math.abs(a).toExponential(2) : Math.abs(a).toPrecision(3);
      const pow = j === 0 ? '' : j === 1 ? 'x' : `x${j === 2 ? '²' : '³'}`;
      terms.push(`${terms.length ? (a < 0 ? ' − ' : ' + ') : (a < 0 ? '−' : '')}${mag}${pow}`);
    }
    return `y = ${terms.join('')} · R² ${f.r2.toFixed(3)}`;
  }

  function applyRanges(v){
    const u = v.plot, st = v.state, c = v.chart;
    if (!u || !st.x) return;
    let [x0, x1] = c.xr || st.x;
    let [y0, y1] = c.yr || st.y;
    if ((c.equal || c.rings) && u.bbox.width > 0 && u.bbox.height > 0){
      const w = u.bbox.width, h = u.bbox.height;
      const ux = (x1 - x0) / w, uy = (y1 - y0) / h;
      if (ux > uy){ const m = (y0 + y1) / 2, half = ux * h / 2; y0 = m - half; y1 = m + half; }
      else { const m = (x0 + x1) / 2, half = uy * w / 2; x0 = m - half; x1 = m + half; }
    }
    st.cur = { x: [x0, x1], y: [y0, y1] };
    u.batch(() => {
      u.setScale('x', { min: x0, max: x1 });
      u.setScale('y', { min: y0, max: y1 });
    });
    drawXYCursor(v);
  }

  function drawRings(u, c){
    if (!c.rings) return;
    const g = u.ctx, b = u.bbox, dpr = devicePixelRatio || 1;
    const X = x => u.valToPos(x, 'x', true), Y = y => u.valToPos(y, 'y', true);
    g.save();
    g.beginPath(); g.rect(b.left, b.top, b.width, b.height); g.clip();
    g.strokeStyle = '#3a3a35'; g.lineWidth = dpr;
    const cx = X(0), cy = Y(0), lim = Math.max(Math.abs(u.scales.x.max), Math.abs(u.scales.x.min));
    for (let r = 0.5; r <= lim + 1e-9; r += 0.5){
      g.beginPath();
      g.ellipse(cx, cy, Math.abs(X(r) - cx), Math.abs(Y(r) - cy), 0, 0, Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = '#46463f';
    g.beginPath(); g.moveTo(b.left, cy); g.lineTo(b.left + b.width, cy); g.moveTo(cx, b.top); g.lineTo(cx, b.top + b.height); g.stroke();
    g.restore();
  }

  function drawPoints(u, v, c){
    const st = v.state;
    if (!st.sets) return;
    const g = u.ctx, b = u.bbox, dpr = devicePixelRatio || 1;
    const { min: xa, max: xb } = u.scales.x, { min: ya, max: yb } = u.scales.y;
    const sx = b.width / (xb - xa), sy = b.height / (yb - ya);
    const sz = Math.max(1, c.size * dpr), off = sz / 2;
    g.save();
    g.beginPath(); g.rect(b.left, b.top, b.width, b.height); g.clip();
    /* Lines: samples joined in the order they were logged, broken wherever samples were
       skipped (a gap in the data, or the edge of a decimation stride) so a dropout does
       not draw a straight line across the chart. */
    if (c.connect){
      g.lineWidth = Math.max(1, c.size * 0.6) * dpr; g.lineJoin = 'round';
      for (const s of st.sets){
        const stride = s.n > 1 ? Math.max(1, Math.round((s.idx[s.n - 1] - s.idx[0]) / Math.max(1, s.n - 1))) : 1;
        const colour = s.primary && st.color;
        const paths = colour ? RAMP.map(() => new Path2D()) : null;
        const one = colour ? null : new Path2D();
        for (let k = 1; k < s.n; k++){
          if (s.idx[k] - s.idx[k - 1] > stride * 2) continue;
          const x0 = b.left + (s.xs[k - 1] - xa) * sx, y0 = b.top + (yb - s.ys[k - 1]) * sy;
          const x1 = b.left + (s.xs[k] - xa) * sx, y1 = b.top + (yb - s.ys[k]) * sy;
          let p = one;
          if (colour){
            const cv = st.color.col[s.idx[k]];
            if (cv !== cv) continue;
            p = paths[rampIndex((cv - st.color.lo) / (st.color.hi - st.color.lo || 1))];
          }
          p.moveTo(x0, y0); p.lineTo(x1, y1);
        }
        g.globalAlpha = s.primary ? 0.9 : 0.55;
        if (colour) paths.forEach((p, i) => { g.strokeStyle = RAMP[i]; g.stroke(p); });
        else { g.strokeStyle = s.color; g.stroke(one); }
        g.globalAlpha = 1;
      }
    }
    for (const s of c.connect ? [] : st.sets){
      if (s.primary && st.color){
        const paths = RAMP.map(() => new Path2D());
        const { col, lo, hi } = st.color, span = hi - lo || 1;
        for (let k = 0; k < s.n; k++){
          const cv = col[s.idx[k]];
          if (cv !== cv) continue;
          paths[rampIndex((cv - lo) / span)].rect(b.left + (s.xs[k] - xa) * sx - off, b.top + (yb - s.ys[k]) * sy - off, sz, sz);
        }
        paths.forEach((p, i) => { g.fillStyle = RAMP[i]; g.fill(p); });
      } else {
        g.fillStyle = s.primary ? withAlpha(s.color, .6) : s.color;
        if (!s.primary) g.globalAlpha = .45;
        g.beginPath();
        for (let k = 0; k < s.n; k++) g.rect(b.left + (s.xs[k] - xa) * sx - off, b.top + (yb - s.ys[k]) * sy - off, sz, sz);
        g.fill();
        g.globalAlpha = 1;
      }
    }
    if (st.fit){
      g.strokeStyle = '#ffffff'; g.lineWidth = 1.5 * dpr; g.setLineDash([]);
      g.beginPath();
      for (let k = 0; k <= 160; k++){
        const x = xa + (xb - xa) * k / 160, px = b.left + (x - xa) * sx, py = b.top + (yb - st.fit.at(x)) * sy;
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.stroke();
    }
    g.restore();
  }

  function sizeCursorCanvas(v){
    const cv = v.state.curCanvas, u = v.plot;
    if (!cv || !u) return;
    const dpr = devicePixelRatio || 1;
    cv.width = Math.round(u.over.clientWidth * dpr);
    cv.height = Math.round(u.over.clientHeight * dpr);
  }
  function drawXYCursor(v){
    const { D } = ctx, st = v.state, u = v.plot, c = v.chart;
    const cv = st.curCanvas;
    if (!cv || !u || !(c.xChan >= 0)) return;
    const g = cv.getContext('2d'), dpr = devicePixelRatio || 1;
    g.clearRect(0, 0, cv.width, cv.height);
    const dot = (i, color, r) => {
      const x = D.cols[c.xChan][i], y = D.cols[c.chans[0]][i];
      if (x !== x || y !== y) return;
      const px = u.valToPos(x, 'x') * dpr, py = u.valToPos(y, 'y') * dpr;
      g.beginPath(); g.arc(px, py, r * dpr, 0, Math.PI * 2);
      g.fillStyle = color; g.fill();
      g.lineWidth = 1.5 * dpr; g.strokeStyle = '#fff'; g.stroke();
    };
    if (D.marker >= 0) dot(D.marker, css('--s4'), 4);
    dot(D.cursor, css('--brand'), 5);
  }
  function hoverXY(v, c, e){
    const st = v.state, u = v.plot;
    const s = st.sets && st.sets.find(x => x.primary);
    if (!s || !u) return;
    const r = u.over.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const { min: xa, max: xb } = u.scales.x, { min: ya, max: yb } = u.scales.y;
    const sx = r.width / (xb - xa), sy = r.height / (yb - ya);
    let best = -1, bd = 144;
    for (let k = 0; k < s.n; k++){
      const dx = (s.xs[k] - xa) * sx - mx, dy = (yb - s.ys[k]) * sy - my;
      const d = dx * dx + dy * dy;
      if (d < bd){ bd = d; best = k; }
    }
    if (best >= 0) ctx.hover(s.idx[best], null);
  }

  /* -------------------------------- histogram -------------------------------- */
  TYPES.hist = {
    sig: c => ['hist', c.chans.map(verOf).join('+'), c.bins, c.norm, c.cumulative, c.range,
      c.overlays && ctx.sessSig(), winKey(c)].join('|'),

    build(v, c){
      const sets = sampleSets(c, c.range === 'all');
      let lo = Infinity, hi = -Infinity;
      for (const s of sets){ const r = finiteRange(s.col, s.i0, s.i1); if (r){ lo = Math.min(lo, r[0]); hi = Math.max(hi, r[1]); } }
      if (!(hi >= lo)){ noData(v, 'No samples in this window.'); return; }
      if (!(hi > lo)){ lo -= 0.5; hi += 0.5; }
      const bins = Math.max(4, Math.min(400, Math.round(+c.bins) || 40));
      const edges = Float64Array.from({ length: bins + 1 }, (_, k) => lo + (hi - lo) * k / bins);
      const data = [edges], series = [{}];
      const unit = { count: 'samples', pct: '% of samples', time: 's' }[c.norm] || '';
      v.state.sets = sets;
      v.state.edges = edges;
      sets.forEach((s, n) => {
        const h = histogram(s.col, s.i0, s.i1, lo, hi, bins);
        const total = h.reduce((a, b) => a + b, 0) || 1;
        const dt = medianStep(s.t, s.i0, s.i1) || 0;
        let acc = 0;
        const y = new Float64Array(bins + 1);
        for (let k = 0; k < bins; k++){
          let val = c.norm === 'pct' ? 100 * h[k] / total : c.norm === 'time' ? h[k] * dt : h[k];
          if (c.cumulative){ acc += val; val = acc; }
          y[k] = val;
        }
        y[bins] = y[bins - 1];
        s.y = y;
        s.desc = describe(s.col, s.i0, s.i1);
        data.push(y);
        series.push({ label: s.name, stroke: s.color, width: 1.5, dash: s.dash,
          fill: n === 0 && !c.cumulative ? withAlpha(ctx.chanColor(s.ci), .3) : undefined,
          paths: c.cumulative ? undefined : uPlot.paths.stepped({ align: 1 }), points: { show: false } });
      });
      const top = Math.max(...data.slice(1).map(a => Math.max(...a))) || 1;
      const opts = {
        ...baseOpts(v, c),
        cursor: { y: false, drag: { x: true, y: false, setScale: true }, points: { show: false } },
        scales: { x: { time: false }, y: { range: () => [0, top * 1.06] } },
        series,
        axes: [
          { ...axisBase(), values: (u, s) => s.map(fmtAxis) },
          { ...axisBase(), size: 54, label: unit, labelSize: 14, labelFont: '10px system-ui', values: (u, s) => s.map(fmtAxis) },
        ],
        hooks: {
          draw: [u => drawHistMarks(u, v, c)],
          setCursor: [u => histRead(v, c, u.cursor.idx)],
        },
      };
      v.plot = new uPlot(opts, data, v.body);
      histRead(v, c, null);
    },
    cursor(v){ if (v.plot) v.plot.redraw(false); },

    csv(v){
      const e = v.state.edges;
      if (!e) return { head: [], rows: [] };
      return {
        head: ['bin from', 'bin to', ...v.state.sets.map(s => s.name)],
        rows: Array.from({ length: e.length - 1 }, (_, k) => [e[k], e[k + 1], ...v.state.sets.map(s => s.y[k])]),
      };
    },
  };

  function drawHistMarks(u, v, c){
    const { D } = ctx, s = v.state.sets && v.state.sets[0];
    if (!s) return;
    const g = u.ctx, b = u.bbox, dpr = devicePixelRatio || 1;
    const line = (x, color, dash, label) => {
      if (!(x === x)) return;
      const px = Math.round(u.valToPos(x, 'x', true)) + 0.5;
      if (px < b.left || px > b.left + b.width) return;
      g.strokeStyle = color; g.setLineDash(dash.map(d => d * dpr)); g.lineWidth = dpr;
      g.beginPath(); g.moveTo(px, b.top); g.lineTo(px, b.top + b.height); g.stroke();
      if (label){ g.fillStyle = color; g.fillText(label, px + 3 * dpr, b.top + 2 * dpr); }
    };
    g.save();
    g.font = `${10 * dpr}px ui-monospace, monospace`; g.textBaseline = 'top';
    line(s.desc.p5, '#6b6b64', [2, 3], 'p5');
    line(s.desc.p95, '#6b6b64', [2, 3], 'p95');
    line(s.desc.mean, css('--ink-2'), [5, 3], 'mean');
    line(D.cols[s.ci][D.cursor], css('--brand'), [], '');
    g.restore();
  }
  function histRead(v, c, idx){
    const read = v.hd.querySelector('.read'), st = v.state;
    if (!read || !st.sets || !st.sets.length) return;
    const s = st.sets[0], f = x => ctx.fmtD(x, 2);
    const suffix = { pct: '%', time: ' s', count: '' }[c.norm] || '';
    if (idx != null && idx < st.edges.length - 1){
      read.innerHTML = `<b>${f(st.edges[idx])} – ${f(st.edges[idx + 1])}</b> ` + st.sets.map(x =>
        `<span style="color:${x.color}">${ctx.fmtD(x.y[idx], c.norm === 'count' ? 0 : 2)}${suffix}</span>`).join(' ');
    } else {
      read.textContent = `mean ${f(s.desc.mean)} · sd ${f(s.desc.sd)} · p5–p95 ${f(s.desc.p5)} – ${f(s.desc.p95)}`;
    }
  }

  /* -------------------------------- spectrum -------------------------------- */
  TYPES.fft = {
    sig: c => ['fft', c.chans.map(verOf).join('+'), c.seg, c.logX, c.logY, c.range,
      c.overlays && ctx.sessSig(), winKey(c)].join('|'),

    build(v, c){
      const sets = sampleSets(c, c.range === 'all');
      const specs = sets.map(s => ({ s, sp: welch(s.col, s.i0, s.i1, medianStep(s.t, s.i0, s.i1), +c.seg || 1024) }));
      const first = specs.find(x => x.sp);
      if (!first){ noData(v, 'Not enough samples in this window for a spectrum &mdash; zoom out, or use a shorter segment in settings.'); return; }
      const k0 = 1;
      const freq = first.sp.freq.subarray(k0);
      const data = [freq], series = [{}], used = [];
      for (const { s, sp } of specs){
        if (!sp) continue;
        const amp = sp === first.sp ? sp.amp.subarray(k0) : resampleOnto(sp.freq, sp.amp, freq, 0, Float64Array);
        data.push(amp);
        used.push({ s, amp });
        series.push({ label: s.name, stroke: s.color, width: 1.4, dash: s.dash, points: { show: false } });
      }
      v.state.specs = used; v.state.freq = freq;
      let peak = 0;
      const a0 = used[0].amp;
      for (let k = 1; k < a0.length; k++) if (a0[k] > a0[peak]) peak = k;
      v.state.peak = peak;
      const maxAmp = Math.max(...used.map(x => Math.max(...x.amp.filter(y => y === y))));
      const unit = ctx.D.units[c.chans[0]] || '';
      const opts = {
        ...baseOpts(v, c),
        cursor: { y: false, drag: { x: true, y: false, setScale: true }, points: { show: false } },
        scales: {
          x: c.logX ? { time: false, distr: 3, log: 10 } : { time: false },
          y: c.logY ? { distr: 3, log: 10, range: () => [maxAmp * 1e-5, maxAmp * 2] } : { range: () => [0, maxAmp * 1.06] },
        },
        series,
        axes: [
          { ...axisBase(), label: 'Hz', labelSize: 14, labelFont: '10px system-ui', values: (u, s) => s.map(x => (x == null ? '' : fmtAxis(x))) },
          { ...axisBase(), size: 58, label: unit ? `amplitude, ${unit}` : 'amplitude', labelSize: 14, labelFont: '10px system-ui',
            values: (u, s) => s.map(x => (x == null ? '' : ctx.fmtD(x, 3))) },
        ],
        hooks: { setCursor: [u => fftRead(v, u.cursor.idx)] },
      };
      v.plot = new uPlot(opts, data, v.body);
      fftRead(v, null);
    },

    csv(v){
      const st = v.state;
      if (!st.freq) return { head: [], rows: [] };
      return { head: ['frequency (Hz)', ...st.specs.map(x => x.s.name)],
        rows: Array.from(st.freq, (f, k) => [f, ...st.specs.map(x => x.amp[k])]) };
    },
  };
  function fftRead(v, idx){
    const read = v.hd.querySelector('.read'), st = v.state;
    if (!read || !st.freq) return;
    const f = x => ctx.fmtD(x, 3);
    if (idx != null) read.innerHTML = `<b>${f(st.freq[idx])} Hz</b> ` + st.specs.map(x =>
      `<span style="color:${x.s.color}">${f(x.amp[idx])}</span>`).join(' ');
    else read.textContent = `peak ${f(st.freq[st.peak])} Hz · ${f(st.specs[0].amp[st.peak])}`;
  }

  /* ------------------------------ statistics ------------------------------ */
  TYPES.stats = {
    sig: c => ['stats', c.chans.map(verOf).join('+'), c.group, c.range, c.overlays && ctx.sessSig(),
      c.group === 'lap' ? ctx.D.laps.length + ':' + (ctx.D.laps[0]?.t0 ?? '') : winKey(c)].join('|'),

    build(v, c){
      const { D, esc } = ctx, f = x => ctx.fmtD(x, 2);
      let head, rows, html;
      if (c.group === 'lap'){
        head = ['Channel', 'Session', 'Lap', 'Lap time', 'Min', 'Max', 'Mean', 'SD', 'P95'];
        rows = [];
        for (const ci of c.chans){
          for (const set of ctx.lapSets(ci, c.overlays)){
            set.laps.forEach(l => {
              const d = describe(set.col, l.i0, l.i1);
              rows.push({ cls: l.partial ? 'partial' : l.best ? 'best' : '',
                cells: [D.label[ci], set.name, l.n, fmtLap(l.time), d.min, d.max, d.mean, d.sd, d.p95] });
            });
          }
        }
      } else {
        head = ['Channel', 'Session', 'Unit', 'Min', 'Max', 'Mean', 'Median', 'SD', 'RMS', 'P5', 'P95', '∫ dt', 'Samples'];
        rows = sampleSets(c, c.range === 'all').map(s => {
          const d = describe(s.col, s.i0, s.i1, s.t);
          return { cls: s.primary ? '' : 'imp', color: s.color,
            cells: [D.label[s.ci], s.s ? s.s.name : 'this session', D.units[s.ci] || '', d.min, d.max, d.mean,
              d.p50, d.sd, d.rms, d.p5, d.p95, d.integral, d.n] };
        });
      }
      const hasSess = rows.some(r => r.cells[1] !== 'this session');
      const show = head.map((h, k) => k !== 1 || hasSess);
      html = `<table class="stats"><thead><tr>${head.map((h, k) => show[k] ? `<th>${h}</th>` : '').join('')}</tr></thead><tbody>${
        rows.map(r => `<tr class="${r.cls}">${r.cells.map((x, k) => !show[k] ? ''
          : `<td>${k === 0 && r.color ? `<span class="sw" style="background:${r.color}"></span>` : ''}${typeof x === 'number' ? (k === 12 || (head[k] === 'Lap') ? x : f(x)) : esc(x)}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
      v.body.innerHTML = rows.length ? `<div class="stats-wrap">${html}</div>` : '<div class="hint chart-msg">No laps to break this down by.</div>';
      v.state.table = { head, rows: rows.map(r => r.cells) };
    },
    csv(v){ return v.state.table || { head: [], rows: [] }; },
  };

  function fmtLap(s){
    if (!isFinite(s)) return '—';
    const m = Math.floor(s / 60), r = s - 60 * m;
    return m ? `${m}:${r.toFixed(2).padStart(5, '0')}` : r.toFixed(2);
  }

  /* ================================ export ================================ */
  function fileBase(v){
    const { D } = ctx;
    return `${(D.meta.Session || 'session')}-${v.chart.type}-${v.chart.chans.map(ci => D.names[ci]).join('+')}`
      .replace(/[^\w.+-]+/g, '_').slice(0, 90);
  }
  function savePng(v){
    const u = v.plot;
    if (!u) return;
    const src = u.ctx.canvas;
    const hd = 26 * (devicePixelRatio || 1);
    const o = document.createElement('canvas');
    o.width = src.width; o.height = src.height + hd;
    const g = o.getContext('2d');
    g.fillStyle = css('--surface'); g.fillRect(0, 0, o.width, o.height);
    g.fillStyle = css('--ink'); g.font = `600 ${12 * (devicePixelRatio || 1)}px system-ui`; g.textBaseline = 'middle';
    g.fillText(v.hd.textContent.replace(/[×⠿ƒ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140), 10, hd / 2);
    g.drawImage(src, 0, hd);
    o.toBlob(b => ctx.download(b, fileBase(v) + '.png'));
  }
  function saveCsv(v){
    const T = TYPES[v.chart.type];
    const { head, rows } = T.csv(v, v.chart);
    const q = x => (typeof x === 'string' && /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x);
    const text = [head.map(q).join(','), ...rows.map(r => r.map(x => (typeof x === 'number' && !isFinite(x) ? '' : q(x))).join(','))].join('\n');
    ctx.download(new Blob([text], { type: 'text/csv' }), fileBase(v) + '.csv');
  }

  /* ================================ dragging ================================
     One gesture does three things, decided by where it is released:
       - on the middle of a chart      add to that chart
       - near a chart's edge, or a gap  a chart of its own, there
       - anywhere else                 nothing; it goes back where it was
     A chart's header lifts the whole chart; one channel's name in a merged chart lifts
     just that channel; a row in the sidebar lifts a copy of that channel.

     Pointer events rather than HTML5 drag-and-drop: native DnD needs a drag image, fights
     uPlot for the pointer, does nothing on touch and cannot give live feedback. */

  function attachLaneDrag(v){
    v.cell.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const hd = e.target.closest('.lane-hd');
      if (!hd || e.target.closest('button')) return;
      e.preventDefault();
      const ser = e.target.closest('.ser');
      press(e, () => {
        const c = ctx.D.charts[v.idx];
        if (!c) return null;
        if (ser && c.chans.length > 1) return { chans: [+ser.dataset.ci], fromIdx: v.idx, whole: false };
        return { chans: c.chans.slice(), fromIdx: v.idx, whole: true };
      });
    });
  }

  function pressChannel(e, ci){
    if (e.button !== 0) return;
    press(e, () => ({ chans: [ci], fromIdx: -1, whole: false, fromSide: true }));
  }

  function press(e, payloadFn){
    const x0 = e.clientX, y0 = e.clientY, pid = e.pointerId;
    let drag = null;
    const move = ev => {
      if (ev.pointerId !== pid) return;
      if (!drag){
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_SLOP) return;
        const p = payloadFn();
        if (!p){ done(); return; }
        drag = beginDrag(p, ev);
      }
      ev.preventDefault();
      drag.move(ev.clientX, ev.clientY);
    };
    const up = ev => {
      if (ev.pointerId !== pid) return;
      done();
      if (drag) drag.end(ev.type === 'pointerup');
    };
    const key = ev => {
      if (ev.key !== 'Escape' || !drag) return;
      ev.preventDefault();
      done();
      drag.end(false);
    };
    function done(){
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      document.removeEventListener('keydown', key, true);
    }
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    document.addEventListener('keydown', key, true);
  }

  function beginDrag(p, ev){
    const { D, chanColor, esc } = ctx;
    const html = document.documentElement;
    html.classList.add('tv-dragging');
    closeChartMenu();

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.innerHTML = `<span class="chips">${p.chans.map(ci => `<span class="chip">
        <span class="sw" style="background:${chanColor(ci)}"></span>${esc(D.label[ci])}</span>`).join('')}</span>
      <span class="act"></span>`;
    document.body.appendChild(ghost);
    const act = ghost.querySelector('.act');

    const src = p.whole ? viewAt(p.fromIdx) : null;
    src?.cell.classList.add('lifted');
    if (!p.whole && p.fromIdx >= 0)
      viewAt(p.fromIdx)?.cell.querySelector(`.ser[data-ci="${p.chans[0]}"]`)?.classList.add('lifted');

    let target = null, lx = ev.clientX, ly = ev.clientY, raf = 0, painted = null;

    function move(x, y){
      lx = x; ly = y;
      ghost.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
      retarget();
      if (!raf) raf = requestAnimationFrame(tick);
    }
    function tick(){
      raf = 0;
      if (!viewRoot) return;
      const r = viewRoot.getBoundingClientRect();
      let dy = 0;
      if (lx >= r.left && lx <= r.right){
        if (ly < r.top + EDGE) dy = -Math.ceil(18 * (1 - Math.max(0, ly - r.top) / EDGE));
        else if (ly > r.bottom - EDGE) dy = Math.ceil(18 * (1 - Math.max(0, r.bottom - ly) / EDGE));
      }
      if (dy){
        const before = viewRoot.scrollTop;
        viewRoot.scrollTop += dy;
        if (viewRoot.scrollTop !== before) retarget();
        raf = requestAnimationFrame(tick);
      }
    }
    function retarget(){ target = hitTest(lx, ly, p); paint(); }

    function paint(){
      const key = target ? `${target.kind}:${target.idx}` : '';
      if (key === painted) return;
      painted = key;
      wrap?.querySelectorAll('.drop-merge').forEach(c => c.classList.remove('drop-merge'));
      viewRoot?.querySelector('.empty-traces')?.classList.toggle('drop-hot', target?.kind === 'end');
      const b = ensureBar();
      if (b) b.classList.remove('on');
      if (!target){
        act.textContent = 'release to cancel';
        ghost.classList.add('idle');
        return;
      }
      ghost.classList.remove('idle');
      if (target.kind === 'merge'){
        const v = viewAt(target.idx);
        v.cell.dataset.drop = p.fromIdx < 0 ? 'Add to this chart' : 'Overlay here';
        v.cell.classList.add('drop-merge');
        act.textContent = p.fromIdx < 0 ? '+ add to chart' : '⇶ overlay';
        return;
      }
      if (target.kind === 'end'){ act.textContent = '+ new chart'; return; }
      act.textContent = p.fromIdx < 0 || !p.whole ? '+ new chart here' : '↕ move here';
      placeBar(viewAt(target.idx), target.kind);
    }

    function end(commit){
      cancelAnimationFrame(raf);
      html.classList.remove('tv-dragging');
      src?.cell.classList.remove('lifted');
      wrap?.querySelectorAll('.lifted').forEach(c => c.classList.remove('lifted'));
      wrap?.querySelectorAll('.drop-merge').forEach(c => c.classList.remove('drop-merge'));
      viewRoot?.querySelector('.empty-traces')?.classList.remove('drop-hot');
      bar?.classList.remove('on');
      ghost.classList.add('gone');
      setTimeout(() => ghost.remove(), 160);
      dragEndedAt = performance.now();
      if (commit && target) applyDrop(p, target);
    }

    move(ev.clientX, ev.clientY);
    return { move, end };
  }

  const viewAt = idx => [...views.values()].find(v => v.idx === idx);

  function layoutRect(cell){
    const wr = wrap.getBoundingClientRect();
    const left = wr.left + cell.offsetLeft, top = wr.top + cell.offsetTop;
    const width = cell.offsetWidth, height = cell.offsetHeight;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  function columns(){
    if (!wrap) return 1;
    return getComputedStyle(wrap).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
  }

  function hitTest(x, y, p){
    const { D } = ctx;
    if (!viewRoot) return null;
    const vr = viewRoot.getBoundingClientRect();
    if (x < vr.left || x > vr.right || y < vr.top || y > vr.bottom) return null;
    if (!views.size) return { kind: 'end', idx: -1 };

    const cols = columns();
    let best = null, bestD = Infinity;
    for (const v of views.values()){
      const r = layoutRect(v.cell);
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = Math.hypot(dx, dy);
      if (d < bestD){ bestD = d; best = { v, r }; }
    }
    const { v, r } = best;
    const wide = v.cell.classList.contains('wide');
    const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    const horiz = cols > 1 && !wide;
    let kind;
    if (bestD > 0) kind = horiz ? (fx < 0.5 ? 'before' : 'after') : (fy < 0.5 ? 'before' : 'after');
    else if (horiz) kind = fx < 0.25 ? 'before' : fx > 0.75 ? 'after' : 'merge';
    else kind = fy < 0.3 ? 'before' : fy > 0.7 ? 'after' : 'merge';

    const idx = v.idx, from = p.fromIdx;
    if (kind === 'merge'){
      if (idx === from) return null;
      if (p.chans.every(c => D.charts[idx].chans.includes(c))) return null;
    } else if (p.whole){
      if (idx === from) return null;
      if (kind === 'after' && idx === from - 1) return null;
      if (kind === 'before' && idx === from + 1) return null;
    }
    return { kind, idx };
  }

  function ensureBar(){
    if (!wrap) return null;
    if (!bar){ bar = document.createElement('div'); bar.className = 'drop-bar'; }
    if (bar.parentNode !== wrap) wrap.appendChild(bar);
    return bar;
  }
  function placeBar(v, kind){
    const b = ensureBar();
    if (!b || !v) return;
    const wr = wrap.getBoundingClientRect(), r = layoutRect(v.cell);
    const gap = parseFloat(getComputedStyle(wrap).columnGap) || 12;
    const T = 4;
    if (columns() > 1 && !v.cell.classList.contains('wide')){
      const x = kind === 'before' ? r.left - gap / 2 : r.right + gap / 2;
      Object.assign(b.style, { left: `${x - wr.left - T / 2}px`, top: `${r.top - wr.top}px`, width: `${T}px`, height: `${r.height}px` });
    } else {
      const y = kind === 'before' ? r.top - gap / 2 : r.bottom + gap / 2;
      Object.assign(b.style, { left: `${r.left - wr.left}px`, top: `${y - wr.top - T / 2}px`, width: `${r.width}px`, height: `${T}px` });
    }
    if (!b.classList.contains('on')){
      b.style.transition = 'none';
      b.getBoundingClientRect();
      b.style.transition = '';
    }
    b.classList.add('on');
  }

  function applyDrop(p, target){
    const { D } = ctx;
    const plotted = new Set(D.charts.flatMap(c => c.chans));
    if (p.fromIdx < 0 && !p.chans.every(ci => plotted.has(ci)) && plotted.size + p.chans.length > ctx.maxPlotted){
      ctx.note(`${ctx.maxPlotted} channels is the most one workspace will plot — remove one first`);
      return;
    }
    const src = p.fromIdx >= 0 ? D.charts[p.fromIdx] : null;
    const at = target.idx >= 0 ? D.charts[target.idx] : null;
    let list = D.charts.slice();
    const insert = chart => {
      if (target.kind === 'end' || !at) list.push(chart);
      else list.splice(list.indexOf(at) + (target.kind === 'after' ? 1 : 0), 0, chart);
    };
    if (p.whole && src){
      list = list.filter(c => c !== src);
      if (target.kind === 'merge') at.chans.push(...src.chans.filter(ci => !at.chans.includes(ci)));
      else insert(src);
    } else {
      if (src){
        src.chans = src.chans.filter(ci => !p.chans.includes(ci));
        if (!src.chans.length) list = list.filter(c => c !== src);
      }
      if (target.kind === 'merge') at.chans.push(...p.chans.filter(ci => !at.chans.includes(ci)));
      else insert(newChart('line', p.chans, src && src.type === 'line' ? { h: src.h, x: src.x } : {}));
    }
    D.charts = list;
    ctx.onChanged();
  }

  /* Drag the bottom edge to give one chart more room. Double-click returns it to the
     default. */
  function addGrip(v){
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'drag to resize · double-click to reset';
    v.cell.appendChild(grip);
    grip.addEventListener('pointerdown', e => {
      e.preventDefault();
      e.stopPropagation();
      try { grip.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      const y0 = e.clientY, h0 = heightOf(v.chart);
      v.cell.classList.add('resizing');
      document.documentElement.classList.add('tv-resizing');
      const move = ev => {
        v.chart.h = Math.max(90, Math.min(900, Math.round(h0 + ev.clientY - y0)));
        applyHeight(v);
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        v.cell.classList.remove('resizing');
        document.documentElement.classList.remove('tv-resizing');
        if (v.chart.type === 'xy') applyRanges(v);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => { v.chart.h = 0; applyHeight(v); });
  }

  return {
    render,
    destroy: destroyAll,
    pressChannel,
    syncCursor,
    justDragged: () => performance.now() - dragEndedAt < 250,
    /* Canvases in layout order, with where each sits relative to the stack, for the
       whole-view PNG. */
    canvases: () => [...views.values()].filter(v => v.plot).map(v => ({ canvas: v.plot.ctx.canvas, el: v.plot.root })),
  };
}
