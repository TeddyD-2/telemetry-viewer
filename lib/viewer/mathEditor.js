import { FUNCS, CONSTS, BUILTINS, MathError, wordAt, quoteName } from './math.js';

/* The dialog for writing a math channel.

   The part that matters is feedback while typing: the expression is evaluated against
   the open session on every pause, so a wrong channel name or a units slip shows up as a
   message pointing at the exact characters, or as a preview trace with an implausible
   range, before anything is saved. Channel names are long and full of spaces, so the
   editor completes them rather than asking anyone to type "FL Water Temp Ou" correctly.

   The viewer supplies everything session-specific through `o`:
     def          { name, unit, expr } when editing, null for a new channel
     channels()   [{ label, unit, math }] that may be referred to
     checkName(s) an error string, or null when the name is usable
     preview(src) the evaluated column; throws MathError
     fmt(v)       number formatting shared with the rest of the viewer
     onSave(def)  / onDelete()                                                         */

export function openMathEditor(host, o){
  const editing = !!o.def;
  const back = document.createElement('div');
  back.className = 'modal-back mx';
  back.innerHTML = `
    <div class="modal mx-modal" role="dialog" aria-modal="true" aria-labelledby="mx-title">
      <div class="modal-hd">
        <span class="mx-badge">ƒ</span>
        <b id="mx-title">${editing ? 'Edit math channel' : 'New math channel'}</b>
        <button class="x" data-close aria-label="Close">×</button>
      </div>
      <div class="mx-row">
        <label class="mx-f mx-name"><span>Name</span>
          <input type="text" data-name spellcheck="false" autocomplete="off" placeholder="Longitudinal g"></label>
        <label class="mx-f mx-unit"><span>Unit</span>
          <input type="text" data-unit spellcheck="false" autocomplete="off" placeholder="g"></label>
      </div>
      <div class="mx-f"><span>Expression</span>
        <div class="mx-ed">
          <textarea data-expr rows="3" spellcheck="false" autocomplete="off"
            aria-label="Expression" aria-autocomplete="list"
            placeholder='smooth(deriv("GPS Speed" / 3.6), 0.25) / g'></textarea>
          <div class="mx-ac" role="listbox" hidden></div>
        </div>
      </div>
      <div class="mx-msg" data-msg aria-live="polite"></div>
      <div class="mx-prev">
        <canvas data-spark></canvas>
        <div class="mx-stats" data-stats></div>
      </div>
      <details class="mx-ref">
        <summary>Functions &amp; syntax</summary>
        <div class="mx-syn">
          <div><code>"GPS Speed"</code> any channel, in quotes &middot; <code>LateralAcc</code> bare, if the name has no spaces</div>
          <div><code>+ - * / % ^</code> &middot; <code>&lt; &lt;= &gt; &gt;= == !=</code> &middot; <code>&amp;&amp; || !</code> give 1 or 0 &middot; <code>cond ? a : b</code></div>
          <div>${Object.keys(CONSTS).map(k => `<code>${k}</code>`).join(' ')} constants &middot;
            ${Object.entries(BUILTINS).map(([k, d]) => `<code>${k}</code> ${d}`).join(' &middot; ')}</div>
        </div>
        <div class="mx-fns">${Object.entries(FUNCS).map(([k, f]) =>
          `<button type="button" class="mx-chip" data-fn="${k}" title="${esc(f.doc || f.sig)}">${esc(f.sig)}</button>`).join('')}</div>
      </details>
      <div class="mx-foot">
        ${editing ? '<button class="btn danger" data-delete>Delete</button>' : ''}
        <label class="mx-share" title="Shared channels reach everyone signed in, on every session that has their inputs">
          <input type="checkbox" data-share ${o.shared ? 'checked' : ''}> Share with the whole team</label>
        <span class="sp"></span>
        <span class="mx-kbd"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
        <button class="btn" data-close>Cancel</button>
        <button class="btn primary" data-save disabled>${editing ? 'Save' : 'Create &amp; plot'}</button>
      </div>
    </div>`;
  host.appendChild(back);

  const q = s => back.querySelector(s);
  const nameIn = q('[data-name]'), unitIn = q('[data-unit]'), exprIn = q('[data-expr]');
  const ac = q('.mx-ac'), msg = q('[data-msg]'), stats = q('[data-stats]');
  const spark = q('[data-spark]'), saveBtn = q('[data-save]');
  const prevFocus = document.activeElement;

  nameIn.value = o.def?.name || '';
  unitIn.value = o.def?.unit || '';
  exprIn.value = o.def?.expr || '';

  let nameTouched = editing, exprOk = false, timer = 0;

  /* ---- live evaluation --------------------------------------------------------- */
  function check(){
    clearTimeout(timer);
    const src = exprIn.value;
    const nameErr = o.checkName(nameIn.value.trim());
    let col = null, err = null;
    if (src.trim()){
      try { col = o.preview(src); }
      catch (e){ err = e instanceof MathError ? e : new MathError(String(e && e.message || e)); }
    }
    exprOk = !!col;
    exprIn.setAttribute('aria-invalid', err ? 'true' : 'false');

    if (err) msg.innerHTML = errorHTML(src, err);
    else if (nameErr && nameTouched) msg.innerHTML = `<span class="bad">${esc(nameErr)}</span>`;
    else if (!src.trim()) msg.innerHTML = '<span class="dim">Start typing a channel name, a number or a function.</span>';
    else msg.innerHTML = '';

    drawSpark(spark, col);
    stats.innerHTML = col ? statsHTML(col, o.fmt, unitIn.value.trim()) : '';
    saveBtn.disabled = !exprOk || !!nameErr;
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 140); };

  /* ---- completion ------------------------------------------------------------- */
  let items = [], active = 0, word = null;

  function candidates(w){
    const t = w.text.toLowerCase();
    const out = [];
    for (const c of o.channels())
      out.push({ kind: 'ch', label: c.label, hint: c.unit, math: c.math, insert: quoteName(c.label) });
    if (!w.quoted){
      for (const [k, f] of Object.entries(FUNCS))
        out.push({ kind: 'fn', label: k, hint: f.sig, insert: `${k}()`, caret: -1 });
      for (const k of Object.keys(CONSTS)) out.push({ kind: 'k', label: k, hint: 'constant', insert: k });
      for (const [k, d] of Object.entries(BUILTINS)) out.push({ kind: 'k', label: k, hint: d, insert: k });
    }
    const score = it => {
      const l = it.label.toLowerCase();
      if (!t) return 3;
      if (l === t) return 0;
      if (l.startsWith(t)) return 1;
      if (l.split(/[\s_]+/).some(p => p.startsWith(t))) return 2;
      return l.includes(t) ? 3 : -1;
    };
    return out.map(it => [score(it), it]).filter(([s]) => s >= 0)
      .sort((a, b) => a[0] - b[0] || a[1].label.length - b[1].label.length)
      .slice(0, 40).map(([, it]) => it);
  }

  function updateAc(){
    word = wordAt(exprIn.value, exprIn.selectionStart);
    if (!word || exprIn.selectionStart !== exprIn.selectionEnd){ closeAc(); return; }
    items = candidates(word);
    /* A bare word that is already exactly a name needs no list: it would only swallow
       the Enter meant for a new line. */
    if (!items.length || (!word.quoted && items.length === 1 && items[0].label === word.text)){
      closeAc(); return;
    }
    active = Math.min(active, items.length - 1);
    ac.innerHTML = items.map((it, i) => `<div class="mx-it ${i === active ? 'on' : ''}" role="option"
        data-k="${i}" aria-selected="${i === active}">
        <span class="mx-kind k-${it.kind}">${it.kind === 'fn' ? 'ƒ()' : it.kind === 'k' ? 'π' : it.math ? 'ƒ' : '∿'}</span>
        <span class="mx-lb">${highlight(it.label, word.text)}</span>
        <span class="mx-hint">${esc(it.hint || '')}</span></div>`).join('');
    ac.hidden = false;
    ac.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  function closeAc(){ ac.hidden = true; items = []; active = 0; }
  function accept(i){
    const it = items[i];
    if (!it || !word) return;
    const src = exprIn.value;
    exprIn.value = src.slice(0, word.start) + it.insert + src.slice(word.end);
    const caret = word.start + it.insert.length + (it.caret || 0);
    exprIn.setSelectionRange(caret, caret);
    closeAc();
    exprIn.focus();
    check();
  }
  ac.addEventListener('pointerdown', e => {
    const el = e.target.closest('.mx-it');
    if (!el) return;
    e.preventDefault();          // keep focus, and the caret, in the textarea
    accept(+el.dataset.k);
  });

  /* ---- wiring ----------------------------------------------------------------- */
  exprIn.addEventListener('input', () => { active = 0; updateAc(); soon(); });
  exprIn.addEventListener('click', updateAc);
  exprIn.addEventListener('blur', () => setTimeout(closeAc, 100));
  exprIn.addEventListener('keydown', e => {
    if (!ac.hidden && items.length){
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        updateAc();
        return;
      }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === 'Tab'){
        e.preventDefault(); accept(active); return;
      }
      if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); closeAc(); return; }
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End')
      setTimeout(updateAc);
  });
  nameIn.addEventListener('input', () => { nameTouched = true; check(); });
  nameIn.addEventListener('blur', () => { nameTouched = true; check(); });
  unitIn.addEventListener('input', soon);

  back.querySelectorAll('[data-fn]').forEach(b => b.addEventListener('click', () => {
    const k = b.dataset.fn;
    const s = exprIn.selectionStart, e = exprIn.selectionEnd, src = exprIn.value;
    /* Wrap a selection -- select a channel, click smooth(). */
    const inner = src.slice(s, e);
    exprIn.value = src.slice(0, s) + `${k}(${inner})` + src.slice(e);
    const caret = s + k.length + 1 + inner.length;
    exprIn.focus();
    exprIn.setSelectionRange(caret, caret);
    check();
  }));

  function save(){
    check();
    if (saveBtn.disabled) return;
    o.onSave({ name: nameIn.value.trim(), unit: unitIn.value.trim(), expr: exprIn.value.trim(),
      shared: q('[data-share]').checked });
    close();
  }
  saveBtn.addEventListener('click', save);
  q('[data-delete]')?.addEventListener('click', () => { o.onDelete(); close(); });
  back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  back.addEventListener('keydown', e => {
    if (e.key === 'Escape'){ e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); save(); }
    e.stopPropagation();          // arrow keys and f/l belong to the viewer only when it has focus
  });

  function close(){
    clearTimeout(timer);
    back.classList.add('out');
    setTimeout(() => back.remove(), 120);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }

  check();
  (editing ? exprIn : nameIn).focus();
  if (editing) exprIn.setSelectionRange(exprIn.value.length, exprIn.value.length);
  return { close };
}

/* ---- rendering helpers ------------------------------------------------------------ */

function esc(s){
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function highlight(label, t){
  const i = t ? label.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (i < 0) return esc(label);
  return esc(label.slice(0, i)) + '<b>' + esc(label.slice(i, i + t.length)) + '</b>' + esc(label.slice(i + t.length));
}

/* The message, then the expression with the offending characters marked. */
function errorHTML(src, err){
  const head = `<span class="bad">${esc(err.message)}</span>`;
  if (!(err.pos >= 0)) return head;
  const a = Math.min(err.pos, src.length), b = Math.max(a + 1, Math.min(err.end, src.length));
  const mark = src.slice(a, b) || ' ';
  return head + `<pre class="mx-where">${esc(src.slice(0, a))}<mark>${esc(mark)}</mark>${esc(src.slice(b))}</pre>`;
}

function statsHTML(col, fmt, unit){
  let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0;
  for (let i = 0; i < col.length; i++){
    const v = col[i];
    if (v === v && v !== Infinity && v !== -Infinity){ if (v < mn) mn = v; if (v > mx) mx = v; sum += v; cnt++; }
  }
  const u = unit ? ` <span class="dim">${esc(unit)}</span>` : '';
  if (!cnt) return '<span class="bad">no finite values — every sample is missing or divides by zero</span>';
  const gaps = col.length - cnt;
  return `<span><span class="dim">min</span> ${fmt(mn)}${u}</span>
    <span><span class="dim">max</span> ${fmt(mx)}${u}</span>
    <span><span class="dim">mean</span> ${fmt(sum / cnt)}${u}</span>
    ${gaps ? `<span class="warnish">${(100 * gaps / col.length).toFixed(gaps < col.length / 100 ? 2 : 0)}% no data</span>` : ''}`;
}

/* The whole session at a glance: one min/max span per pixel column, so a spike that
   would tell you the scaling is wrong cannot fall between samples. */
function drawSpark(cv, col){
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const css = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
  if (!col || !col.length){
    g.strokeStyle = css('--line'); g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(0, h / 2 + .5); g.lineTo(w, h / 2 + .5); g.stroke();
    return;
  }
  const n = col.length, W = Math.max(1, Math.floor(w));
  const lo = new Float64Array(W).fill(Infinity), hi = new Float64Array(W).fill(-Infinity);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < n; i++){
    const v = col[i];
    if (!(v === v) || v === Infinity || v === -Infinity) continue;
    const px = Math.min(W - 1, Math.floor(i * W / n));
    if (v < lo[px]) lo[px] = v;
    if (v > hi[px]) hi[px] = v;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (mn === Infinity) return;
  if (!(mx > mn)){ mn -= 1; mx += 1; }
  const pad = 4, Y = v => pad + (h - 2 * pad) * (1 - (v - mn) / (mx - mn));
  if (mn < 0 && mx > 0){
    g.strokeStyle = css('--line');
    g.beginPath(); g.moveTo(0, Math.round(Y(0)) + .5); g.lineTo(w, Math.round(Y(0)) + .5); g.stroke();
  }
  g.strokeStyle = css('--s1'); g.lineWidth = 1.2; g.lineJoin = 'round';
  g.beginPath();
  let pen = false;
  for (let px = 0; px < W; px++){
    if (lo[px] === Infinity){ pen = false; continue; }
    const x = px + .5;
    if (!pen){ g.moveTo(x, Y(hi[px])); pen = true; } else g.lineTo(x, Y(hi[px]));
    g.lineTo(x, Y(lo[px]));
  }
  g.stroke();
}
