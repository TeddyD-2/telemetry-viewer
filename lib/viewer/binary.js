/* A compact on-the-wire form of a parsed session.

   An AiM export is text: 83 MB for the Michigan endurance run, and every viewer who
   opens it pays that download plus a full reparse. The same session as typed arrays is
   ~33 MB, and gzip takes it to roughly a third of that -- float columns from a physical
   sensor are smooth, so the byte planes repeat. More importantly the reader is a memcpy
   rather than a parse, so opening a shared session is a download and nothing else.

   The CSV is still stored alongside it: it is the artefact people hand to RS3 or Excel,
   and it is the thing to fall back on if this format ever needs to change.

   Layout, little-endian throughout:
     magic   "TVB1"                    4 bytes
     hdrLen  uint32                    4 bytes
     header  JSON, utf-8               hdrLen bytes, padded to an 8-byte boundary
     columns raw Float32/Float64 data, in header order, each 8-byte aligned          */

const MAGIC = 0x31425654; // "TVB1"
const align8 = n => (n + 7) & ~7;

export function encodeParsed(m){
  const dtypes = m.cols.map(c => (c instanceof Float64Array ? 64 : 32));
  const header = new TextEncoder().encode(JSON.stringify({
    meta: m.meta, names: m.names, units: m.units, n: m.n, dtypes,
  }));
  const hdrEnd = align8(8 + header.length);

  let total = hdrEnd;
  const offsets = m.cols.map(c => { const at = total; total = align8(at + c.byteLength); return at; });

  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, header.length, true);
  new Uint8Array(buf, 8, header.length).set(header);
  const bytes = new Uint8Array(buf);
  m.cols.forEach((c, i) => bytes.set(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), offsets[i]));
  return buf;
}

export function decodeParsed(buf){
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a telemetry cache file');
  const hdrLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hdrLen)));
  let at = align8(8 + hdrLen);
  const cols = header.dtypes.map(bits => {
    const A = bits === 64 ? Float64Array : Float32Array;
    /* Copy rather than view: `at` is 8-byte aligned so a view would be legal, but the
       viewer keeps these arrays for the life of the session and a view would pin the
       whole multi-megabyte buffer alive behind them. */
    const col = new A(header.n);
    col.set(new A(buf, at, header.n));
    at = align8(at + col.byteLength);
    return col;
  });
  return { meta: header.meta, names: header.names, units: header.units, cols, n: header.n };
}

/* gzip via CompressionStream. Every browser that can run the viewer has it; if one
   cannot, the payload is stored and served uncompressed and everything still works. */
export const canCompress = () => typeof CompressionStream !== 'undefined';

export async function gzip(buf){
  if (!canCompress()) return buf;
  const cs = new CompressionStream('gzip');
  return await new Response(new Blob([buf]).stream().pipeThrough(cs)).arrayBuffer();
}

export async function gunzip(buf){
  const b = new Uint8Array(buf);
  if (!(b[0] === 0x1f && b[1] === 0x8b)) return buf;   // stored uncompressed
  const ds = new DecompressionStream('gzip');
  return await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
}

/* Fetch a cached session, reporting bytes as they arrive so a 20 MB download over a
   paddock hotspot shows a bar instead of a frozen page. */
export async function fetchParsed(url, onProgress){
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch the session (${res.status})`);
  const total = +res.headers.get('content-length') || 0;

  let buf;
  if (!res.body || !onProgress){
    buf = await res.arrayBuffer();
  } else {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;){
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      onProgress(total ? Math.round(100 * got / total) : -1, got, total);
    }
    buf = new Blob(chunks).arrayBuffer ? await new Blob(chunks).arrayBuffer() : null;
  }
  return decodeParsed(await gunzip(buf));
}
