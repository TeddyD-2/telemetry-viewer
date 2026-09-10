import uPlot from 'uplot';
import { lowerBound, resampleOnto, sectorTimes, describe } from './analysis.js';
import { RAMP, rampAt } from './palette.js';

/* Lap analysis: the track and the laps side by side, the numbers underneath.

   This was two views. Track was the map; Compare was a channel against distance for the
   ticked laps, with delta-t under it. They answer halves of one question -- where on the
   lap is the time going -- and splitting them meant reading "gains 0.3 s at 1.2 km" off
   one screen and then switching views to find out which corner 1.2 km is. Now hovering
   either one moves both: the chart's cursor puts a dot on the map for every lap at that
   distance, and hovering the map moves the charts.

   Every lap is resampled onto one distance grid, so the laps share an x array and uPlot
   can draw, zoom and cursor them together. Laps can come from imported sessions; they
   are timed from this session's start/finish line (compare.js), which is what makes a
   delta-t between two days mean something.

   ctx: { D, fmtD, fmtT, esc, entries() -> [{ key, S, sName, lap, primary, hue, dash }],
          ref() -> entry | null, colIn(S, ci), speedOf(S), setRef(key), toggleLap(key),
          moveSF(i), hover(i), channelList(), sessSig(), onChanged() }                 */

const MARGIN = 8;

export function createLapView(ctx){
  let root = null, el = null, plots = [], grid = null, entries = [], ref = null;
  let sig = '', mapSig = '', mapT = null, series = [];
  let ro = null, roTimer = 0;

  const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  const fmtDist = v => (v == null ? '' : Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + ' km' : v.toFixed(0) + ' m');

  function destroy(){
    plots.forEach(p => p.u.destroy());
    plots = [];
    if (ro){ ro.disconnect(); ro = null; }
    el = null; sig = ''; mapSig = '';
  }

  function render(view){
    const { D } = ctx;
    if (!el || el.parentNode !== view){
      destroy();
      root = view;
      view.innerHTML = '';
      view.className = '';
      el = document.createElement('div');
      el.className = 'lapview';
      view.appendChild(el);
      ro = new ResizeObserver(() => { clearTimeout(roTimer); roTimer = setTimeout(() => { sig = ''; mapSig = ''; render(root); }, 90); });
      ro.observe(view);
    }
    entries = ctx.entries();
    ref = ctx.ref();
    const s = [entries.map(e => e.key + ':' + e.hue).join(','), ref && ref.key, D.cmpChans.map(ci => `${ci}:${D.colVer[ci] || 0}`).join(),
      ctx.sessSig(), D.sectors, D.laps.map(l => l.t0.toFixed(3)).join(), view.clientWidth, view.clientHeight].join('|');
    if (s !== sig){
      sig = s;
      build();
    }
    drawMap();
    syncHover(null);
  }

  /* ---------------------------------- layout ---------------------------------- */
  function build(){
    const { D, esc } = ctx;
    plots.forEach(p => p.u.destroy());
    plots = [];
    const vh = root.clientHeight;
    const topH = Math.max(380, Math.min(780, Math.round(vh * 0.64)));
    el.innerHTML = `
      <section class="lane lv-map" style="height:${topH}px">
        <div class="lane-hd static">
          <span class="nm">Track</span>
          <label class="lv-pick"><span>colour</span><select data-mapchan aria-label="Colour the map by"></select></label>
          <span class="lv-hint">click the line to move start/finish</span>
        </div>
        <div class="lv-mapbox"><canvas class="base"></canvas><canvas class="over"></canvas></div>
      </section>
      <section class="lv-charts" style="height:${topH}px"></section>
      <section class="lane lv-data"></section>`;

    const sel = el.querySelector('[data-mapchan]');
    sel.innerHTML = ctx.channelList().map(c => `<option value="${c.i}" ${c.i === D.mapChan ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
    sel.onchange = () => { D.mapChan = +sel.value; mapSig = ''; drawMap(); };
    bindMap();

    const charts = el.querySelector('.lv-charts');
    if (!D.laps.length && !entries.length){
      charts.innerHTML = `<div class="lane lv-empty"><div class="hint">No laps found. Laps need a speed and a
        position channel &mdash; check Channel roles in the sidebar &mdash; or click the track to place the start/finish line.</div></div>`;
      buildTable();
      return;
    }
    if (!entries.length){
      charts.innerHTML = `<div class="lane lv-empty"><div class="hint"><b>Tick laps to compare.</b>
        Click a lap's swatch in the Laps panel. The reference lap for delta-t is picked there too, or by clicking a row in the table below.</div></div>`;
      buildTable();
      return;
    }

    buildGrid();
    const n = D.cmpChans.length + 1;
    const gap = 10, hdH = 30;
    const h = Math.max(110, Math.floor((topH - gap * (n - 1)) / n) - hdH);
    D.cmpChans.forEach(ci => addPlot(charts, ci, h));
    addPlot(charts, -1, h);
    buildTable();
  }

  /* One grid for every lap, as long as the longest and as fine as the reference lap's
     own samples. Past the end of a shorter lap its series is a gap, not a held value. */
  function buildGrid(){
    const base = ref || entries[0];
    const lens = entries.map(e => e.lap.d1 - e.lap.d0);
    const maxLen = Math.max(1, ...lens);
    const refLen = Math.max(1, base.lap.d1 - base.lap.d0);
    const N = Math.max(300, Math.min(8000, Math.round((base.lap.i1 - base.lap.i0) * maxLen / refLen)));
    grid = Float64Array.from({ length: N }, (_, k) => k * maxLen / (N - 1));
    series = entries.map(e => ({ e, t: lapCol(e, e.S.t, true) }));
    const rs = ref && series.find(s => s.e.key === ref.key);
    series.forEach(s => {
      s.dt = new Float64Array(N);
      for (let k = 0; k < N; k++) s.dt[k] = rs ? s.t[k] - rs.t[k] : NaN;
    });
  }
  function lapCol(e, col, isTime){
    const { S, lap } = e;
    const a = Math.max(0, lap.i0 - MARGIN), b = Math.min(S.n, lap.i1 + MARGIN + 1);
    const out = resampleOnto(S.dist.subarray(a, b), col.subarray(a, b), grid, lap.d0, isTime ? Float64Array : Float32Array);
    const len = lap.d1 - lap.d0;
    for (let k = 0; k < grid.length; k++){
      if (grid[k] > len + 1e-6) out[k] = NaN;
      else if (isTime) out[k] -= lap.t0;
    }
    return out;
  }

  function addPlot(host, ci, h){
    const { D, esc } = ctx;
    const delta = ci < 0;
    const lane = document.createElement('div');
    lane.className = 'lane lv-chart';
    const title = delta
      ? `<span class="nm">Delta-t</span><span class="u">s vs ${ref ? esc(ref.label) : '—'} · below zero is ahead</span>`
      : `<span class="nm">${esc(D.label[ci])}</span><span class="u">${esc(D.units[ci] || '')}</span>`;
    lane.innerHTML = `<div class="lane-hd static">${title}<span class="lv-vals"></span>
      ${delta ? '' : `<button class="drop" data-rm="${ci}" title="stop comparing ${esc(D.label[ci])}">×</button>`}</div><div class="lane-body"></div>`;
    host.appendChild(lane);
    lane.querySelector('[data-rm]')?.addEventListener('click', () => {
      D.cmpChans = D.cmpChans.filter(x => x !== ci);
      ctx.onChanged();
    });

    const data = [grid], ser = [{}];
    for (const s of series){
      const y = delta ? s.dt : lapCol(s.e, ctx.colIn(s.e.S, ci) || new Float32Array(s.e.S.n).fill(NaN), false);
      data.push(y);
      ser.push({ label: s.e.label, stroke: s.e.hue, width: s.e.key === ref?.key ? 2 : 1.4, dash: s.e.dash, points: { show: false } });
    }
    const body = lane.querySelector('.lane-body');
    const axis = { stroke: css('--ink-3'), grid: { stroke: css('--grid'), width: 1 }, ticks: { stroke: css('--grid'), width: 1 }, font: '11px ui-monospace, monospace' };
    const u = new uPlot({
      width: Math.max(160, host.clientWidth - 2),
      height: h,
      padding: [8, 12, 0, 0],
      legend: { show: false },
      cursor: { y: false, drag: { x: true, y: false, setScale: false }, points: { show: false } },
      scales: {
        x: { time: false, min: D.lapZoom ? D.lapZoom[0] : 0, max: D.lapZoom ? D.lapZoom[1] : grid[grid.length - 1] },
        y: { range: (uu, mn, mx) => {
          if (mn == null || !(mx >= mn)) return [-1, 1];
          if (delta){ mn = Math.min(mn, -0.1); mx = Math.max(mx, 0.1); }
          if (!(mx > mn)) return [mn - 1, mx + 1];
          const p = (mx - mn) * 0.08;
          return [mn - p, mx + p];
        } },
      },
      series: ser,
      axes: [{ ...axis, values: (uu, s) => s.map(fmtDist) },
             { ...axis, size: 54, values: (uu, s) => s.map(v => ctx.fmtD(v, Math.abs(v) >= 100 ? 0 : delta ? 2 : 1)) }],
      hooks: {
        setCursor: [uu => {
          const i = uu.cursor.idx;
          if (i == null) return;
          D.lapHover = grid[i];
          syncHover(uu);
        }],
        setSelect: [uu => {
          if (uu.select.width <= 0) return;
          const a = uu.posToVal(uu.select.left, 'x'), b = uu.posToVal(uu.select.left + uu.select.width, 'x');
          uu.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          zoom([Math.min(a, b), Math.max(a, b)]);
        }],
        drawClear: [uu => { if (delta) zeroLine(uu); }],
      },
    }, data, body);
    u.over.addEventListener('dblclick', () => zoom(null));
    u.over.addEventListener('wheel', e => {
      e.preventDefault();
      const r = u.over.getBoundingClientRect();
      const at = u.posToVal(Math.max(0, Math.min(r.width, e.clientX - r.left)), 'x');
      const { min, max } = u.scales.x;
      const f = e.deltaY > 0 ? 1.25 : 0.8;
      zoom([at - (at - min) * f, at + (max - at) * f]);
    }, { passive: false });
    plots.push({ u, lane, ci, delta, data });
  }

  function zeroLine(u){
    const g = u.ctx, y = Math.round(u.valToPos(0, 'y', true)) + 0.5;
    g.save(); g.strokeStyle = '#6b6b64'; g.lineWidth = devicePixelRatio || 1;
    g.beginPath(); g.moveTo(u.bbox.left, y); g.lineTo(u.bbox.left + u.bbox.width, y); g.stroke(); g.restore();
  }

  function zoom(range){
    const { D } = ctx;
    const end = grid ? grid[grid.length - 1] : 1;
    if (range){
      let [a, b] = range;
      const span = Math.min(end, Math.max(b - a, end * 0.002));
      a = Math.max(0, Math.min(a, end - span));
      D.lapZoom = [a, a + span];
      if (D.lapZoom[0] <= 0 && D.lapZoom[1] >= end) D.lapZoom = null;
    } else D.lapZoom = null;
    const [x0, x1] = D.lapZoom || [0, end];
    plots.forEach(p => p.u.setScale('x', { min: x0, max: x1 }));
  }

  /* ---------------------------------- hover ---------------------------------- */
  function syncHover(from){
    const { D } = ctx;
    if (grid && D.lapHover != null){
      const k = Math.min(grid.length - 1, lowerBound(grid, D.lapHover));
      for (const p of plots){
        if (p.u !== from){
          const left = p.u.valToPos(grid[k], 'x');
          p.u.setCursor({ left: left >= 0 && left <= p.u.over.clientWidth ? left : -10, top: 10 }, false);
        }
        const vals = p.lane.querySelector('.lv-vals');
        vals.innerHTML = `<b>${fmtDist(grid[k])}</b>` + series.map((s, j) => {
          const v = p.data[j + 1][k];
          return `<span style="color:${s.e.hue}">${esc(s.e.short)} ${v === v ? (p.delta ? (v >= 0 ? '+' : '') + v.toFixed(2) : ctx.fmtD(v, 1)) : '—'}</span>`;
        }).join('');
      }
    }
    drawOver();
  }
  const esc = s => ctx.esc(s);

  /* ----------------------------------- map ----------------------------------- */
  function bindMap(){
    const box = el.querySelector('.lv-mapbox'), over = el.querySelector('canvas.over');
    const nearest = e => {
      if (!mapT) return -1;
      const { D } = ctx;
      const r = over.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      let bi = -1, bd = 400;
      for (let i = 0; i < D.n; i += 2){
        const x = D.x[i];
        if (x !== x) continue;
        const dx = mapT.PX(x) - mx, dy = mapT.PY(D.y[i]) - my, d = dx * dx + dy * dy;
        if (d < bd){ bd = d; bi = i; }
      }
      return bi;
    };
    box.onmousemove = e => {
      const i = nearest(e);
      if (i < 0) return;
      const { D } = ctx;
      const own = entries.find(x => x.primary && i >= x.lap.i0 && i <= x.lap.i1)
        || { lap: D.laps.find(l => i >= l.i0 && i <= l.i1) };
      if (own.lap) D.lapHover = Math.max(0, D.dist[i] - own.lap.d0);
      ctx.hover(i);
      syncHover(null);
    };
    box.onclick = e => { const i = nearest(e); if (i >= 0) ctx.moveSF(i); };
  }

  function drawMap(){
    const { D } = ctx;
    const base = el.querySelector('canvas.base'), over = el.querySelector('canvas.over');
    const box = el.querySelector('.lv-mapbox');
    if (!base) return;
    if (!D.x){
      box.innerHTML = `<div class="hint lv-nomap">The map needs latitude and longitude channels &mdash; set them under Channel roles.</div>`;
      mapT = null;
      return;
    }
    const w = box.clientWidth, h = box.clientHeight, dpr = devicePixelRatio || 1;
    const s = [w, h, D.mapChan, D.colVer[D.mapChan] || 0, D.sf, ref && ref.key, entries.map(e => e.key).join(), D.laps.length].join('|');
    if (s === mapSig) return;
    mapSig = s;
    for (const cv of [base, over]){ cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    const g = base.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const lo = D.laps.length ? D.laps[0].i0 : 0, hi = D.laps.length ? D.laps[D.laps.length - 1].i1 : D.n - 1;
    for (let i = lo; i <= hi; i++){ const a = D.x[i], b = D.y[i]; if (a === a){ if (a < x0) x0 = a; if (a > x1) x1 = a; if (b < y0) y0 = b; if (b > y1) y1 = b; } }
    const m = 22, sc = Math.min((w - 2 * m) / (x1 - x0 || 1), (h - 2 * m - 26) / (y1 - y0 || 1));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const PX = v => w / 2 + (v - cx) * sc, PY = v => (h - 26) / 2 - (v - cy) * sc;
    mapT = { PX, PY };

    g.lineCap = 'round'; g.lineJoin = 'round';
    const path = (X, Y, a, b) => {
      g.beginPath();
      let pen = false;
      for (let i = a; i <= b; i++){
        const x = X[i];
        if (x !== x){ pen = false; continue; }
        if (pen) g.lineTo(PX(x), PY(Y[i])); else { g.moveTo(PX(x), PY(Y[i])); pen = true; }
      }
    };
    g.lineWidth = 7; g.strokeStyle = '#242422';
    path(D.x, D.y, lo, hi); g.stroke();

    /* Colour one lap, not the session: the reference if it is this session's, else the
       first ticked lap of this session. A whole session's ramp spends its range on the
       paddock crawl and makes every real lap look the same. */
    const colourLap = (ref && ref.primary ? ref : entries.find(e => e.primary))?.lap
      || (D.laps.length ? { i0: D.laps[0].i0, i1: D.laps[D.laps.length - 1].i1 } : { i0: 0, i1: D.n - 1 });
    const col = D.cols[D.mapChan];
    let vlo = Infinity, vhi = -Infinity;
    for (let i = colourLap.i0; i <= colourLap.i1; i++){ const v = col[i]; if (v === v){ if (v < vlo) vlo = v; if (v > vhi) vhi = v; } }
    if (!(vhi > vlo)){ vlo = (vlo === Infinity ? 0 : vlo) - 1; vhi = vlo + 2; }
    const buckets = RAMP.map(() => new Path2D());
    for (let i = Math.max(1, colourLap.i0); i <= colourLap.i1; i++){
      if (D.x[i] !== D.x[i] || D.x[i - 1] !== D.x[i - 1]) continue;
      const b = buckets[Math.max(0, Math.min(RAMP.length - 1, Math.floor((col[i] - vlo) / (vhi - vlo) * RAMP.length)))];
      b.moveTo(PX(D.x[i - 1]), PY(D.y[i - 1])); b.lineTo(PX(D.x[i]), PY(D.y[i]));
    }
    g.lineWidth = 3.2;
    buckets.forEach((p, i) => { g.strokeStyle = RAMP[i]; g.stroke(p); });

    /* Imported laps as thin lines in their own colour: a different line through a corner
       is usually the first thing worth seeing. */
    for (const e of entries){
      if (e.primary || !e.S.x) continue;
      g.lineWidth = 1.3; g.strokeStyle = e.hue; g.globalAlpha = .85;
      path(e.S.x, e.S.y, e.lap.i0, e.lap.i1); g.stroke();
      g.globalAlpha = 1;
    }

    if (D.sf != null){
      const sx = PX(D.x[D.sf]), sy = PY(D.y[D.sf]);
      g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.arc(sx, sy, 7, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#fff'; g.font = '600 10px system-ui'; g.textAlign = 'center';
      g.fillText('S/F', sx, sy - 11);
    }
    const kw = 150, kx = w - 12 - kw, ky = h - 20;
    RAMP.forEach((c, i) => { g.fillStyle = c; g.fillRect(kx + i * kw / RAMP.length, ky, kw / RAMP.length + 1, 7); });
    g.fillStyle = css('--ink-3'); g.font = '10px ui-monospace, monospace';
    g.textAlign = 'right'; g.fillText(ctx.fmtD(vlo, 1), kx - 6, ky + 7);
    g.textAlign = 'left'; g.fillText(ctx.fmtD(vhi, 1), kx + kw + 4, ky + 7);
    g.textAlign = 'left'; g.fillStyle = css('--ink-3');
    g.fillText(ref && ref.primary ? `colour: ${ref.short}` : 'colour', 12, ky + 7);
  }

  function drawOver(){
    const { D } = ctx;
    const over = el && el.querySelector('canvas.over');
    if (!over || !mapT) return;
    const g = over.getContext('2d'), dpr = devicePixelRatio || 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, over.width, over.height);
    const dot = (X, Y, i, fill, r) => {
      const x = X[i];
      if (x !== x) return;
      g.beginPath(); g.arc(mapT.PX(x), mapT.PY(Y[i]), r, 0, Math.PI * 2);
      g.fillStyle = fill; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#0e0e0d'; g.stroke();
    };
    if (D.lapHover != null && entries.length){
      for (const e of [...entries].reverse()){
        if (!e.S.x) continue;
        const i = Math.min(e.lap.i1, lowerBound(e.S.dist, e.lap.d0 + D.lapHover, e.lap.i0, e.lap.i1 + 1));
        dot(e.S.x, e.S.y, i, e.hue, e.key === ref?.key ? 6 : 4.5);
      }
    } else dot(D.x, D.y, D.cursor, css('--brand'), 5.5);
  }

  /* ---------------------------------- table ---------------------------------- */
  function buildTable(){
    const { D, esc, fmtT } = ctx;
    const box = el.querySelector('.lv-data');
    const nSec = D.sectors;
    const sessions = new Map();
    for (const e of entries) if (!sessions.has(e.sName)) sessions.set(e.sName, e.S);

    const rows = entries.map(e => {
      const sp = ctx.speedOf(e.S);
      const d = sp ? describe(sp, e.lap.i0, e.lap.i1) : null;
      return {
        e, time: e.lap.time,
        sec: nSec > 1 ? sectorTimes(e.S.dist, e.S.t, e.lap, nSec) : [],
        vmax: d ? d.max : NaN, vmin: d ? d.min : NaN,
        chans: D.cmpChans.slice(0, 3).map(ci => { const c = ctx.colIn(e.S, ci); return c ? describe(c, e.lap.i0, e.lap.i1).mean : NaN; }),
      };
    });
    const ideal = [...sessions].map(([name, S]) => {
      if (nSec < 2) return null;
      const timed = S.laps.filter(l => !l.partial);
      if (timed.length < 2) return null;
      const best = new Array(nSec).fill(Infinity);
      for (const l of timed) sectorTimes(S.dist, S.t, l, nSec).forEach((t, k) => { if (t < best[k]) best[k] = t; });
      return { name, sec: best, time: best.reduce((a, b) => a + b, 0) };
    }).filter(Boolean);

    const bestSec = Array.from({ length: nSec > 1 ? nSec : 0 }, (_, k) => Math.min(...rows.map(r => r.sec[k])));
    const bestTime = Math.min(...rows.map(r => r.time));
    const refTime = ref ? ref.lap.time : NaN;
    const multi = sessions.size > 1 || entries.some(e => !e.primary);
    const delta = t => (!(t === t) || !(refTime === refTime) ? '—' : (t - refTime >= 0 ? '+' : '−') + Math.abs(t - refTime).toFixed(2));
    const secCells = (r, highlight) => r.sec.map((t, k) => `<td class="${highlight && Math.abs(t - bestSec[k]) < 1e-9 ? 'bestc' : ''}">${t.toFixed(2)}</td>`).join('');

    const head = `<tr><th></th><th>Lap</th>${multi ? '<th>Session</th>' : ''}<th>Time</th><th>Δ ref</th>
      ${bestSec.map((_, k) => `<th>S${k + 1}</th>`).join('')}<th>Speed max</th><th>Speed min</th>
      ${D.cmpChans.slice(0, 3).map(ci => `<th title="mean over the lap">${esc(D.label[ci])} avg</th>`).join('')}<th></th></tr>`;
    const body = rows.map(r => `<tr data-key="${r.e.key}" class="${r.e.key === ref?.key ? 'ref' : ''}" title="click to make this the reference lap">
      <td><span class="sw" style="background:${r.e.hue}"></span></td>
      <td>${r.e.lap.n}${r.e.key === ref?.key ? ' <span class="tag">ref</span>' : ''}${r.e.lap.partial ? ' <span class="dim">partial</span>' : ''}</td>
      ${multi ? `<td class="sess">${esc(r.e.sName)}</td>` : ''}
      <td class="${Math.abs(r.time - bestTime) < 1e-9 ? 'bestc' : ''}">${fmtT(r.time)}</td><td>${delta(r.time)}</td>
      ${secCells(r, rows.length > 1)}
      <td>${ctx.fmtD(r.vmax, 1)}</td><td>${ctx.fmtD(r.vmin, 1)}</td>
      ${r.chans.map(v => `<td>${ctx.fmtD(v, 2)}</td>`).join('')}
      <td><button class="drop" data-untick="${r.e.key}" title="stop comparing this lap">×</button></td></tr>`).join('');
    const idealRows = ideal.map(r => `<tr class="ideal" title="the best of each sector over every timed lap of that session">
      <td></td><td>Ideal</td>${multi ? `<td class="sess">${esc(r.name)}</td>` : ''}
      <td>${fmtT(r.time)}</td><td>${delta(r.time)}</td>${r.sec.map(t => `<td>${t.toFixed(2)}</td>`).join('')}
      <td></td><td></td>${D.cmpChans.slice(0, 3).map(() => '<td></td>').join('')}<td></td></tr>`).join('');

    box.innerHTML = `<div class="lane-hd static"><span class="nm">Laps compared</span>
        <span class="u">${entries.length} lap${entries.length === 1 ? '' : 's'}</span>
        <label class="lv-pick"><span>sectors</span><select data-sectors>${[1, 2, 3, 4, 5, 6].map(k =>
          `<option value="${k}" ${k === nSec ? 'selected' : ''}>${k === 1 ? 'none' : k}</option>`).join('')}</select></label>
        <span class="lv-hint">sectors are equal fractions of each lap's distance · Ideal is the best of each sector</span></div>
      ${entries.length ? `<div class="stats-wrap"><table class="stats lv-table"><thead>${head}</thead><tbody>${body}${idealRows}</tbody></table></div>`
        : '<div class="hint" style="padding:10px 12px">No laps ticked.</div>'}`;
    box.querySelector('[data-sectors]').onchange = e => { D.sectors = +e.target.value; ctx.onChanged(); };
    box.onclick = e => {
      const un = e.target.closest('[data-untick]');
      if (un){ ctx.toggleLap(un.dataset.untick); return; }
      const tr = e.target.closest('tr[data-key]');
      if (tr) ctx.setRef(tr.dataset.key);
    };
  }

  return { render, destroy };
}

export { rampAt };
