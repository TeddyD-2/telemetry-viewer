import { fmtDuration, fmtWhen } from '../format.js';

/* Choosing a second session to compare against.

   Two places a session can come from, and the dialog says which is which rather than
   blending them: the team library, which is someone's shared run and downloads the
   compact cached copy, and a CSV on this computer, which is parsed here and goes nowhere.
   The viewer does the loading; this only asks.

   o: { exclude       library id of the open session, which is not offered against itself
        imported()    library ids already open as comparisons
        loadLibrary(dataset, onProgress) -> Promise
        loadFile(file, onProgress)       -> Promise }                                   */

export function openImporter(host, o){
  const back = document.createElement('div');
  back.className = 'modal-back mx imp';
  back.innerHTML = `
    <div class="modal imp-modal" role="dialog" aria-modal="true" aria-labelledby="imp-title">
      <div class="modal-hd">
        <b id="imp-title">Add a session to compare</b>
        <button class="x" data-close aria-label="Close">×</button>
      </div>
      <div class="seg imp-tabs" role="tablist">
        <button role="tab" data-tab="lib" class="on" aria-selected="true">Team library</button>
        <button role="tab" data-tab="file" aria-selected="false">CSV on this computer</button>
      </div>
      <div data-pane="lib">
        <input type="search" data-q placeholder="Search titles, drivers, cars, notes&hellip;" aria-label="Search the library">
        <div class="imp-list" data-list><div class="hint imp-empty">Loading the library&hellip;</div></div>
      </div>
      <div data-pane="file" hidden>
        <div class="imp-drop" data-drop>
          <b>Drop an AiM CSV here</b>
          <span>or <button class="linky" data-pick>choose a file</button>
            &middot; it is read in this browser and not uploaded</span>
        </div>
        <input type="file" accept=".csv" data-file hidden>
        <div class="imp-status" data-fstatus aria-live="polite"></div>
      </div>
      <p class="imp-note">Charts overlay the same channel from it, dashed. Its laps join the
        lap table, timed from this session's start/finish line so the two line up.</p>
    </div>`;
  host.appendChild(back);

  const q = s => back.querySelector(s);
  const list = q('[data-list]'), search = q('[data-q]');
  const prevFocus = document.activeElement;
  let datasets = null;

  function close(){
    document.removeEventListener('keydown', onKey, true);
    back.classList.add('out');
    setTimeout(() => back.remove(), 120);
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  }
  const onKey = e => { if (e.key === 'Escape'){ e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  back.querySelectorAll('[data-close]').forEach(b => { b.onclick = close; });

  back.querySelectorAll('[data-tab]').forEach(b => {
    b.onclick = () => {
      back.querySelectorAll('[data-tab]').forEach(x => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-selected', String(x === b));
      });
      back.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
      (b.dataset.tab === 'lib' ? search : q('[data-pick]')).focus();
    };
  });

  /* ---- the library ---- */
  fetch('/api/datasets')
    .then(r => r.json().then(b => ({ ok: r.ok, b })))
    .then(({ ok, b }) => {
      if (!ok || b.error) throw new Error(b.error || 'the library did not answer');
      datasets = (b.datasets || []).filter(d => d.id !== o.exclude);
      fill();
    })
    .catch(err => {
      list.innerHTML = `<div class="hint imp-empty">Could not load the library: ${esc(err.message || err)}.
        A CSV on this computer still works.</div>`;
    });

  function fill(){
    if (!datasets) return;
    const needle = search.value.trim().toLowerCase();
    const have = new Set(o.imported ? o.imported() : []);
    const shown = datasets.filter(d => !needle || [d.title, d.description, d.uploader, d.session, d.vehicle, d.racer]
      .filter(Boolean).join(' ').toLowerCase().includes(needle));
    if (!shown.length){
      list.innerHTML = `<div class="hint imp-empty">${datasets.length ? 'No sessions match that search.' : 'The library has no other sessions yet.'}</div>`;
      return;
    }
    list.innerHTML = shown.map(d => `
      <div class="imp-row" data-id="${esc(d.id)}">
        <div class="imp-main">
          <div class="imp-title">${esc(d.title)}</div>
          <div class="imp-facts">${[
            d.uploader, d.recordedAt || fmtWhen(d.createdAt), d.vehicle, d.racer && `driver ${d.racer}`,
            d.laps > 0 && `${d.laps} laps`, d.durationS > 0 && fmtDuration(d.durationS),
          ].filter(Boolean).map(esc).join(' &middot; ')}</div>
          <div class="imp-prog" hidden><i></i></div>
          <div class="imp-err" hidden></div>
        </div>
        <button class="btn" data-add ${have.has(d.id) ? 'disabled' : ''}>${have.has(d.id) ? 'Added' : 'Add'}</button>
      </div>`).join('');
  }
  search.oninput = fill;
  setTimeout(() => search.focus(), 0);

  list.onclick = async e => {
    const btn = e.target.closest('[data-add]');
    if (!btn || btn.disabled) return;
    const row = btn.closest('.imp-row');
    const d = datasets.find(x => x.id === row.dataset.id);
    const bar = row.querySelector('.imp-prog'), err = row.querySelector('.imp-err');
    btn.disabled = true; btn.textContent = 'Opening…';
    bar.hidden = false; err.hidden = true;
    try {
      await o.loadLibrary(d, pct => { if (pct >= 0) bar.firstElementChild.style.width = pct + '%'; });
      close();
    } catch (x){
      bar.hidden = true;
      err.hidden = false; err.textContent = String(x && x.message || x);
      btn.disabled = false; btn.textContent = 'Add';
    }
  };

  /* ---- a file ---- */
  const drop = q('[data-drop]'), input = q('[data-file]'), status = q('[data-fstatus]');
  q('[data-pick]').onclick = () => input.click();
  input.onchange = () => input.files[0] && takeFile(input.files[0]);
  /* The viewer listens for drops on the whole document, where a CSV means "open this
     instead". Inside this dialog it means "compare against this", so the drop stops here. */
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); drop.classList.add('hot');
  });
  drop.addEventListener('dragleave', e => { e.stopPropagation(); drop.classList.remove('hot'); });
  back.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
  back.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    drop.classList.remove('hot');
    const f = e.dataTransfer.files[0];
    if (f) takeFile(f);
  });

  async function takeFile(f){
    status.innerHTML = `<div>Reading ${esc(f.name)} (${(f.size / 1048576).toFixed(1)} MB)&hellip;</div>
      <div class="imp-prog"><i></i></div>`;
    const bar = status.querySelector('.imp-prog i');
    try {
      await o.loadFile(f, pct => { if (pct >= 0) bar.style.width = pct + '%'; });
      close();
    } catch (x){
      status.innerHTML = `<div class="imp-err">${esc(x && x.message || x)}</div>`;
    }
  }
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
