/* Round-trips a real AiM export through the cache format and checks every sample.

   This is the one thing in the sharing feature that can be wrong silently. A bad title
   is obvious; a column that comes back shifted by one, or quietly demoted from Float64
   to Float32, produces a lap trace that looks entirely plausible and is not the session
   anyone recorded. So: parse the CSV, encode, gzip, gunzip, decode, and compare bit for
   bit against what the parser produced.

     node scripts/check-session-cache.mjs [path/to/session.csv]                        */

import { readFileSync } from 'node:fs';
import { WORKER_SRC } from '../lib/viewer/parse.js';
import { encodeParsed, decodeParsed, gzip, gunzip } from '../lib/viewer/binary.js';

const file = process.argv[2] || 'data/endurance.csv';

/* The parser lives as worker source so the browser can run it off the main thread.
   Node has no Worker here, so evaluate the same text and call parseAll directly --
   testing the shipped string rather than a copy of it is the whole point. */
function parseInProcess(buf){
  const body = WORKER_SRC.replace(/onmessage[\s\S]*$/, '') + '\nreturn parseAll(BUF);';
  // eslint-disable-next-line no-new-func
  return new Function('BUF', 'postMessage', body)(buf, () => {});
}

const fail = [];
const check = (ok, what) => { if (!ok) fail.push(what); return ok; };

const bytes = readFileSync(file);
const t0 = Date.now();
const parsed = parseInProcess(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
const tParse = Date.now() - t0;

const raw = encodeParsed(parsed);
const packed = await gzip(raw);
const back = decodeParsed(await gunzip(packed));

check(back.n === parsed.n, `sample count ${back.n} != ${parsed.n}`);
check(back.names.length === parsed.names.length, 'channel count changed');
check(JSON.stringify(back.names) === JSON.stringify(parsed.names), 'channel names changed');
check(JSON.stringify(back.units) === JSON.stringify(parsed.units), 'units changed');
check(JSON.stringify(back.meta) === JSON.stringify(parsed.meta), 'session metadata changed');

let worstAt = null;
for (let c = 0; c < parsed.cols.length; c++){
  const a = parsed.cols[c], b = back.cols[c];
  if (!check(a.constructor === b.constructor, `${parsed.names[c]}: ${a.constructor.name} became ${b.constructor.name}`)) continue;
  if (!check(a.length === b.length, `${parsed.names[c]}: length changed`)) continue;
  for (let i = 0; i < a.length; i++){
    /* NaN is a legitimate value here -- it is how the parser records an empty field --
       so compare the bit patterns, not the numbers. */
    if (!(a[i] === b[i] || (a[i] !== a[i] && b[i] !== b[i]))){ worstAt = `${parsed.names[c]}[${i}]: ${a[i]} != ${b[i]}`; break; }
  }
  if (worstAt) break;
}
check(!worstAt, worstAt);

/* Latitude is the reason columns are not all Float32: 42.06887946 needs the precision. */
const latIdx = parsed.names.findIndex(n => /latitude/i.test(n));
if (latIdx >= 0){
  check(back.cols[latIdx] instanceof Float64Array, 'latitude lost its Float64 storage');
  check(back.cols[latIdx][0] === parsed.cols[latIdx][0],
    `latitude drifted: ${back.cols[latIdx][0]} != ${parsed.cols[latIdx][0]}`);
}

const mb = n => (n / 1048576).toFixed(1) + ' MB';
console.log(`${file}`);
console.log(`  parsed        ${parsed.n.toLocaleString()} samples x ${parsed.names.length} channels in ${tParse} ms`);
console.log(`  csv           ${mb(bytes.length)}`);
console.log(`  cache         ${mb(raw.byteLength)} raw, ${mb(packed.byteLength)} gzipped ` +
            `(${(bytes.length / packed.byteLength).toFixed(1)}x smaller than the csv)`);

if (fail.length){
  console.error('\nFAILED:');
  for (const f of fail) console.error('  ' + f);
  process.exit(1);
}
console.log('  round trip    every sample identical');
