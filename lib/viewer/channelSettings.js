/* One channel's settings: its team note, and for a math channel whether the team has it.

   The note is what a teammate would otherwise have to tell you in the paddock -- "that
   accelerometer reads 26% high", "use #2, #1 is the dead ECU speed". It is keyed by the
   channel's name, so it follows the channel onto every session, and it is shown as the
   channel's tooltip wherever the channel is listed.

   o: { label, unit, range, note: {note, updatedBy, updatedAt} | null,
        math: { expr, team, by } | null,
        saveNote(text) -> Promise, share(on) -> Promise, editMath() }                    */

export function openChannelSettings(host, o){
  const back = document.createElement('div');
  back.className = 'modal-back mx chs';
  const noteBy = n => (n ? `Last edited by ${esc(n.updatedBy || 'someone')}${n.updatedAt ? `, ${new Date(n.updatedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}` : '');
  back.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="chs-title">
      <div class="modal-hd">
        <b id="chs-title">${esc(o.label)}</b>
        <button class="x" data-close aria-label="Close">×</button>
      </div>
      <div class="chs-facts">${[o.unit && esc(o.unit), esc(o.range)].filter(Boolean).join(' &middot; ')}</div>
      ${o.math ? `<div class="chs-math">
        <div class="chs-expr"><span class="mx-badge">ƒ</span><code>${esc(o.math.expr)}</code></div>
        <div class="chs-share">
          <span data-status>${o.math.team ? `Shared with the team${o.math.by ? ` &middot; added by ${esc(o.math.by)}` : ''}` : 'Personal &middot; only in this browser'}</span>
          <span class="sp"></span>
          <button class="btn" data-edit>Edit expression&hellip;</button>
          <button class="btn ${o.math.team ? '' : 'primary'}" data-share>${o.math.team ? 'Stop sharing' : 'Share with team'}</button>
        </div>
      </div>` : ''}
      <label class="mx-f"><span>Team note</span>
        <textarea data-note rows="4" maxlength="2000"
          placeholder="What should people know about this channel? e.g. reads ~26% high; sensor swapped on 12 June; use #2 on 2025 exports">${esc(o.note?.note || '')}</textarea>
      </label>
      <div class="chs-cap">Everyone on the team sees this as the channel's tooltip, on every session. ${noteBy(o.note)}</div>
      <div class="mx-msg" data-msg aria-live="polite"></div>
      <div class="mx-foot">
        <span class="sp"></span>
        <span class="mx-kbd"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
        <button class="btn" data-close>Close</button>
        <button class="btn primary" data-save disabled>Save note</button>
      </div>
    </div>`;
  host.appendChild(back);

  const q = s => back.querySelector(s);
  const ta = q('[data-note]'), save = q('[data-save]'), msg = q('[data-msg]');
  const prevFocus = document.activeElement;
  const initial = o.note?.note || '';

  ta.addEventListener('input', () => { save.disabled = ta.value.trim() === initial.trim(); msg.textContent = ''; });

  async function doSave(){
    if (save.disabled) return;
    save.disabled = true; save.textContent = 'Saving…';
    try {
      await o.saveNote(ta.value.trim());
      close();
    } catch (err){
      msg.innerHTML = `<span class="bad">${esc(err.message || err)}</span>`;
      save.disabled = false; save.textContent = 'Save note';
    }
  }
  save.addEventListener('click', doSave);

  q('[data-edit]')?.addEventListener('click', () => { close(); o.editMath(); });
  q('[data-share]')?.addEventListener('click', async e => {
    const btn = e.currentTarget, on = !o.math.team;
    btn.disabled = true;
    try {
      await o.share(on);
      o.math.team = on;
      btn.textContent = on ? 'Stop sharing' : 'Share with team';
      btn.classList.toggle('primary', !on);
      q('[data-status]').innerHTML = on ? 'Shared with the team' : 'Personal &middot; only in this browser';
    } catch (err){
      msg.innerHTML = `<span class="bad">${esc(err.message || err)}</span>`;
    }
    btn.disabled = false;
  });

  back.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
  back.addEventListener('keydown', e => {
    if (e.key === 'Escape'){ e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); doSave(); }
    e.stopPropagation();
  });

  function close(){
    back.classList.add('out');
    setTimeout(() => back.remove(), 120);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
