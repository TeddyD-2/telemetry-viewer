/* A chart's settings, in a popover off its header.

   Everything about a chart that is a choice rather than data lives here, per chart: its
   kind, its channels, its x axis and scale, how it draws. It is a popover rather than a
   sidebar panel because a setting belongs to one chart, and the header of that chart is
   where anyone would look for it. Each change applies immediately -- there is no Apply
   button to forget -- and the popover stays open so the effect can be seen and undone.

   The popover lives on document.body rather than inside the chart, because changing a
   chart's kind rebuilds the chart. */

let open = null;

export function closeChartMenu(){ if (open) open.close(); }
export const chartMenuFor = () => (open ? open.chart : null);

export function openChartMenu({ anchor, chart, ctx, types, retype, onChange, actions }){
  if (open && open.chart === chart){ closeChartMenu(); return; }
  closeChartMenu();
  const { D, esc } = ctx;
  const el = document.createElement('div');
  el.className = 'cmenu';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Chart settings');
  document.body.appendChild(el);

  const chanOpts = (sel, none) => (none ? `<option value="-1">${none}</option>` : '')
    + ctx.channelList().map(c => `<option value="${c.i}" ${c.i === sel ? 'selected' : ''}>${esc(c.label)}${c.unit ? ` — ${esc(c.unit)}` : ''}</option>`).join('');

  const get = path => path.split('.').reduce((o, k) => (o == null ? o : o[k]), chart);
  const set = (path, val) => {
    const ks = path.split('.'), last = ks.pop();
    ks.reduce((o, k) => o[k], chart)[last] = val;
  };

  const row = (label, control, cls = '') => `<div class="cm-row ${cls}"><span>${label}</span>${control}</div>`;
  const seg = (path, opts) => `<span class="seg cm-seg">${opts.map(([val, label, title]) =>
    `<button data-set="${path}" data-val='${JSON.stringify(val)}' class="${get(path) === val ? 'on' : ''}"${title ? ` title="${title}"` : ''}>${label}</button>`).join('')}</span>`;
  const check = (path, label) => `<label class="cm-check"><input type="checkbox" data-bool="${path}" ${get(path) ? 'checked' : ''}> ${label}</label>`;
  const samples = () => row('Samples', seg('range', [['view', 'Zoom window'], ['all', 'Whole session']]));

  function body(){
    const c = chart, sessions = ctx.compare().length;
    let h = `<div class="cm-hd"><b>Chart settings</b><button class="x" data-close aria-label="Close">×</button></div>`;
    h += row('Kind', `<select data-type>${types.map(t =>
      `<option value="${t.type}" ${t.type === c.type ? 'selected' : ''} title="${t.hint}">${t.label}</option>`).join('')}</select>`);
    h += `<div class="cm-row cm-chans"><span>${c.type === 'xy' ? 'Y channels' : 'Channels'}</span><div>
      ${c.chans.map(ci => `<span class="cm-chip"><i style="background:${ctx.chanColor(ci)}"></i>${esc(D.label[ci])}
        <button data-rm="${ci}" title="remove" aria-label="remove ${esc(D.label[ci])}">×</button></span>`).join('')}
      <select data-add aria-label="Add a channel">${chanOpts(-2, '+ add channel…')}</select></div></div>`;

    /* One X axis picker for both kinds: time and distance are what a line chart is drawn
       against, any channel makes it an XY chart. Switching between them is just picking. */
    const xAxis = () => row('X axis', `<select data-xaxis>
      <option value="__auto" ${c.type === 'line' && c.x === 'auto' ? 'selected' : ''}>Follow toolbar (${D.xMode === 'time' ? 'time' : 'distance'})</option>
      <option value="__time" ${c.type === 'line' && c.x === 'time' ? 'selected' : ''}>Time</option>
      <option value="__dist" ${c.type === 'line' && c.x === 'dist' ? 'selected' : ''}>Distance</option>
      <optgroup label="any channel">${chanOpts(c.type === 'xy' ? c.xChan : -2)}</optgroup></select>`);

    if (c.type === 'line'){
      h += `<div class="cm-sec">Axes</div>`;
      h += xAxis();
      h += row('Y scale', seg('y.mode', [['auto', 'Auto', 'fit what is on screen'], ['zero', 'From zero'], ['fixed', 'Fixed']]));
      if (c.y.mode === 'fixed') h += row('Range', `<span class="cm-range"><input type="number" step="any" data-str="y.min" value="${esc(c.y.min)}" placeholder="min">
        <span>to</span><input type="number" step="any" data-str="y.max" value="${esc(c.y.max)}" placeholder="max"></span>`);
      h += row('', check('y.log', 'Logarithmic'));
      if (c.chans.length > 1) h += row('Channels share', seg('axes', [['independent', 'Own scales', 'each channel fills the height; first two get an axis each side'], ['shared', 'One scale', 'directly comparable values, one axis']]));
      h += `<div class="cm-sec">Drawing</div>`;
      h += row('Style', seg('style', [['line', 'Line'], ['step', 'Step'], ['points', 'Points'], ['area', 'Area']]));
      h += row('Reference lines', `<input type="text" data-str="refs" value="${esc(c.refs)}" placeholder="e.g. 0, 1.5, 80">`);
      h += row('', check('laps', 'Lap start lines') + check('stats', 'Min / avg / max in header'));
    } else if (c.type === 'xy'){
      h += `<div class="cm-sec">Axes</div>`;
      h += xAxis();
      h += row('Colour by', `<select data-int="colorBy">${chanOpts(c.colorBy, 'nothing — channel colour')}</select>`);
      h += samples();
      h += row('', check('equal', 'Equal aspect') + check('rings', 'g rings, centred'));
      h += `<div class="cm-sec">Drawing</div>`;
      h += row('Draw', seg('connect', [[false, 'Points'], [true, 'Lines', 'join samples in time order']]));
      h += row(c.connect ? 'Line / point' : 'Point size', seg('size', [[1, 'S'], [2, 'M'], [3.5, 'L']]));
      h += row('Trend line', seg('fit', [[0, 'None'], [1, 'Linear'], [2, 'Quadratic'], [3, 'Cubic']]));
      h += row('Zoom', `<span class="hint">drag a box on the chart · double-click to reset</span>`);
    } else if (c.type === 'hist'){
      h += `<div class="cm-sec">Bins</div>`;
      h += row('Bins', `<input type="number" min="4" max="400" step="1" data-num="bins" value="${c.bins}">`);
      h += row('Height', seg('norm', [['pct', '% samples'], ['time', 'Seconds'], ['count', 'Count']]));
      h += row('', check('cumulative', 'Cumulative'));
      h += samples();
    } else if (c.type === 'fft'){
      h += `<div class="cm-sec">Spectrum</div>`;
      h += row('Segment', `<select data-num="seg">${[256, 512, 1024, 2048, 4096, 8192, 16384].map(n =>
        `<option value="${n}" ${+c.seg === n ? 'selected' : ''}>${n} samples</option>`).join('')}</select>`);
      h += row('', `<span class="hint">longer segments resolve finer frequencies; shorter ones average more and are smoother</span>`);
      h += row('', check('logX', 'Log frequency') + check('logY', 'Log amplitude'));
      h += samples();
    } else if (c.type === 'stats'){
      h += `<div class="cm-sec">Table</div>`;
      h += row('Rows', seg('group', [['window', 'Per channel'], ['lap', 'Per lap']]));
      if (c.group !== 'lap') h += samples();
    }

    h += `<div class="cm-sec">Layout</div>`;
    h += row('', check('wide', 'Full width') + (sessions ? check('overlays', 'Show imported sessions') : ''));
    h += `<div class="cm-foot">
      <button class="btn" data-act="duplicate">Duplicate</button>
      <button class="btn" data-act="resetZoom">Reset zoom</button>
      ${actions.png ? '<button class="btn" data-act="png">PNG</button>' : ''}
      <button class="btn" data-act="csv">CSV</button>
      <span class="sp"></span>
      <button class="btn danger" data-act="remove">Delete</button></div>`;
    el.innerHTML = h;
  }

  const commit = () => { onChange(); body(); place(); };

  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.close !== undefined){ close(); return; }
    if (b.dataset.set){ set(b.dataset.set, JSON.parse(b.dataset.val)); commit(); return; }
    if (b.dataset.rm){
      const ci = +b.dataset.rm;
      if (chart.chans.length <= 1){ actions.remove(); return; }
      chart.chans = chart.chans.filter(x => x !== ci);
      commit();
      return;
    }
    if (b.dataset.act){
      const fn = actions[b.dataset.act];
      if (!fn) return;
      fn();
      if (b.dataset.act === 'duplicate' || b.dataset.act === 'remove') close();
    }
  });
  el.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-type]')){ retype(chart, t.value); commit(); return; }
    if (t.matches('[data-xaxis]')){
      if (t.value.startsWith('__')){
        if (chart.type !== 'line') retype(chart, 'line');
        chart.x = t.value.slice(2);
      } else {
        const wasLine = chart.type === 'line';
        if (!wasLine) retype(chart, 'xy');
        else { retype(chart, 'xy'); chart.connect = true; chart.xr = chart.yr = null; }
        chart.xChan = +t.value;
      }
      commit();
      return;
    }
    if (t.matches('[data-add]')){
      const ci = +t.value;
      if (ci >= 0 && !chart.chans.includes(ci)) chart.chans.push(ci);
      commit();
      return;
    }
    if (t.dataset.bool){ set(t.dataset.bool, t.checked); commit(); return; }
    if (t.dataset.int){ set(t.dataset.int, parseInt(t.value, 10)); commit(); return; }
    if (t.dataset.num){ const n = +t.value; if (n === n) set(t.dataset.num, n); commit(); return; }
    if (t.dataset.str !== undefined){ set(t.dataset.str, t.value); commit(); }
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.matches('input[type=text],input[type=number]')) e.target.blur();
  });

  function place(){
    const r = (anchor.isConnected ? anchor : document.body).getBoundingClientRect();
    const w = el.offsetWidth, vh = window.innerHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    let top = r.bottom + 6;
    if (top + 240 > vh) top = Math.max(8, r.top - Math.min(el.scrollHeight, vh - 16) - 6);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.maxHeight = (vh - top - 8) + 'px';
  }

  const outside = e => { if (!el.contains(e.target) && !(anchor.isConnected && anchor.contains(e.target))) close(); };
  const key = e => { if (e.key === 'Escape'){ e.stopPropagation(); close(); } };
  const onResize = () => close();
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', onResize);

  function close(){
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', onResize);
    el.remove();
    if (open && open.el === el) open = null;
  }

  open = { chart, el, close };
  body();
  place();
}
