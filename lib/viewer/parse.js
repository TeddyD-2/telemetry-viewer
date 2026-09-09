/* CSV parsing, shared by the viewer and the upload page.

   The worker is still built from an inline blob rather than a separate bundled file:
   it keeps the parser and its one caller in the same module, and Next's worker plumbing
   buys nothing here since the source is a plain string with no imports. */
/* ============================ CSV parsing (worker) ============================
   An 83 MB / 226-channel AiM export is normal, and doing that on the main thread
   freezes the tab for seconds. Numbers are parsed straight out of the byte array:
   building the mantissa as one integer and scaling once keeps full precision on GPS
   coordinates (10 significant figures), which digit-by-digit accumulation loses. */
export const WORKER_SRC = `
const DEC = new TextDecoder();
function parseAll(buf){
  const b = new Uint8Array(buf), N = b.length;
  // --- header block: find the channel-name row (its first field is "Time") ---
  const head = DEC.decode(b.subarray(0, Math.min(N, 262144)));
  const lines = head.split(/\\r?\\n/);
  const meta = {};
  let hi = -1;
  for (let i = 0; i < lines.length; i++){
    const f = splitCsv(lines[i]);
    if (f.length > 8 && f[0] === 'Time'){ hi = i; break; }
    if (f.length === 2) meta[f[0]] = f[1];
  }
  if (hi < 0) throw new Error('No channel header row found \u2014 is this an AiM CSV export?');
  const names = splitCsv(lines[hi]);
  let ui = hi + 1;
  while (ui < lines.length && lines[ui].trim() === '') ui++;
  const units = splitCsv(lines[ui]);
  // byte offset of the first data row = past the units row and any blank lines
  let off = 0;
  for (let i = 0; i <= ui; i++) off += byteLen(lines[i]) + nlLen(b, off + byteLen(lines[i]));
  while (off < N && (b[off] === 13 || b[off] === 10)) off++;

  const nCol = names.length;
  // count rows first so the typed arrays are allocated once, exactly
  let rows = 0;
  for (let i = off; i < N; i++) if (b[i] === 10) rows++;
  if (N > off && b[N-1] !== 10) rows++;

  const precise = names.map(n => /latitude|longitude/i.test(n));
  const cols = names.map((_, c) => precise[c] ? new Float64Array(rows) : new Float32Array(rows));

  let r = 0, c = 0, i = off, lastPct = 0;
  while (i < N){
    const ch = b[i];
    if (ch === 34){ i++; continue; }                       // skip quotes
    if (ch === 44){ c++; i++; continue; }                  // field separator
    if (ch === 10){ r++; c = 0; i++;
      if ((r & 2047) === 0){ const p = Math.round(90*i/N); if (p > lastPct){ lastPct = p; postMessage({t:'p', p:10+p}); } }
      continue; }
    if (ch === 13){ i++; continue; }
    // ---- number ----
    let neg = false;
    if (ch === 45){ neg = true; i++; } else if (ch === 43) i++;
    let mant = 0, exp = 0, any = false;
    while (i < N){
      const d = b[i];
      if (d >= 48 && d <= 57){ mant = mant*10 + (d-48); any = true; i++; }
      else if (d === 46){ i++;
        while (i < N && b[i] >= 48 && b[i] <= 57){ mant = mant*10 + (b[i]-48); exp--; any = true; i++; }
      }
      else if (d === 101 || d === 69){ i++;
        let es = 1; if (b[i] === 45){ es = -1; i++; } else if (b[i] === 43) i++;
        let ev = 0; while (i < N && b[i] >= 48 && b[i] <= 57){ ev = ev*10 + (b[i]-48); i++; }
        exp += es*ev;
      }
      else break;
    }
    if (any && r < rows && c < nCol){
      let v = exp ? mant * Math.pow(10, exp) : mant;
      cols[c][r] = neg ? -v : v;
    } else if (!any && r < rows && c < nCol){
      cols[c][r] = NaN;
      while (i < N && b[i] !== 44 && b[i] !== 10) i++;     // skip a non-numeric field
    }
  }
  return {meta, names, units, cols, n: rows};
}
function byteLen(s){ let n = 0; for (let i = 0; i < s.length; i++){ const c = s.codePointAt(i);
  n += c < 128 ? 1 : c < 2048 ? 2 : c < 65536 ? 3 : (i++, 4); } return n; }
function nlLen(b, p){ return (b[p] === 13 && b[p+1] === 10) ? 2 : 1; }
function splitCsv(line){
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++){
    const ch = line[i];
    if (ch === '"'){ if (q && line[i+1] === '"'){ cur += '"'; i++; } else q = !q; }
    else if (ch === ',' && !q){ out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}
onmessage = e => {
  try{
    postMessage({t:'p', p:8});
    const r = parseAll(e.data);
    postMessage({t:'done', ...r}, r.cols.map(a => a.buffer));
  }catch(err){ postMessage({t:'err', m: String(err && err.message || err)}); }
};`;


/* Parse an AiM CSV in a worker. Resolves with the same shape the viewer ingests:
   {meta, names, units, cols, n}. `onProgress` is called with 0-100. */
export function parseCsvFile(file, onProgress){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], {type:'text/javascript'}));
    const w = new Worker(url);
    const done = fn => { w.terminate(); URL.revokeObjectURL(url); fn(); };
    w.onmessage = e => {
      const m = e.data;
      if (m.t === 'p') onProgress && onProgress(m.p);
      else if (m.t === 'err') done(() => reject(new Error(m.m)));
      else if (m.t === 'done') done(() => resolve(m));
    };
    w.onerror = e => done(() => reject(new Error(e.message || 'parser crashed')));
    const fr = new FileReader();
    fr.onerror = () => done(() => reject(new Error('could not read the file')));
    fr.onload = () => w.postMessage(fr.result, [fr.result]);
    fr.readAsArrayBuffer(file);
  });
}
