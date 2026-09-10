/* Math channels: the expression language, and a few channels built against the real file.

     node scripts/check-math.mjs                                                        */

import { readFileSync, existsSync } from 'node:fs';
import { WORKER_SRC } from '../lib/viewer/parse.js';
import { parse, evaluate, refs, wordAt, renameRef, MathError } from '../lib/viewer/math.js';

let failures = 0;
function check(ok, what){
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
  if (!ok) failures++;
  return ok;
}
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

/* A tiny session: 101 samples at 10 Hz. */
const n = 101;
const time = Float64Array.from({ length: n }, (_, i) => i / 10);
const cols = {
  'GPS Speed': Float32Array.from({ length: n }, (_, i) => 36 + i),     // km/h
  Speed1: Float32Array.from({ length: n }, () => 10),
  'Brake "Front"': Float32Array.from({ length: n }, (_, i) => (i % 2 ? 1 : NaN)),
  Time: time,
};
const env = {
  n, time, dist: null,
  channel: name => cols[name] || null,
};
const run = src => evaluate(parse(src), env);
const scalar = src => run(src)[0];

console.log('arithmetic and precedence');
check(scalar('1 + 2 * 3') === 7, '1 + 2 * 3 = 7');
check(scalar('(1 + 2) * 3') === 9, '(1 + 2) * 3 = 9');
check(scalar('-2^2') === -4, '-2^2 = -4, as on paper');
check(scalar('2^3^2') === 512, '^ is right-associative');
check(scalar('2 ** 3') === 8, '** means ^');
check(scalar('7 % 4') === 3, 'modulo');
check(scalar('1 < 2 && 3 >= 3') === 1, 'comparisons and && give 1/0');
check(scalar('!0 + !5') === 1, '! negates');
check(scalar('1 > 2 ? 10 : 1 < 2 ? 20 : 30') === 20, 'ternary nests to the right');
check(near(scalar('pi'), Math.PI) && near(scalar('g'), 9.80665), 'constants');
check(scalar('1.5e2 + .5') === 150.5, 'number formats');

console.log('channels');
{
  const v = run('"GPS Speed" / 3.6');
  check(near(v[0], 10) && near(v[100], 136 / 3.6, 1e-6), 'quoted name, scaled');
  check(run('Speed1 * 2')[50] === 20, 'bare identifier name');
  check(run("'GPS Speed'")[3] === 39, 'single quotes too');
  check(run('Time')[10] === 1 && run('time')[10] === 1, 'a logged Time channel wins, time falls back to built-in');
  check(Number.isNaN(run('\'Brake "Front"\' + 1')[0]) && run('\'Brake "Front"\' + 1')[1] === 2,
    'a name with double quotes inside, and NaN passes through');
  const r = refs(parse('max("GPS Speed", Speed1) + g'));
  check(r.has('GPS Speed') && r.has('Speed1') && r.has('g'), 'refs lists every name used');
}

console.log('functions');
check(scalar('max(1, 7, 3)') === 7 && scalar('min(4, -2)') === -2, 'min / max are variadic');
check(scalar('clamp(12, 0, 10)') === 10, 'clamp');
check(scalar('hypot(3, 4)') === 5, 'hypot');
check(near(scalar('deg(atan2(1, 1))'), 45), 'atan2 and deg');
check(scalar('if(0, 1, 2)') === 2, 'if()');
check(scalar('LOG(e)') === 1, 'function names are case-insensitive, log is ln');
check(run('isnan(\'Brake "Front"\')')[0] === 1, 'isnan');
{
  const d = run('deriv("GPS Speed")');                  // +1 km/h per 0.1 s
  check(near(d[0], 10, 1e-5) && near(d[50], 10, 1e-5) && near(d[100], 10, 1e-5),
    'deriv: 10 km/h/s everywhere, including both ends');
  const I = run('integ(Speed1)');
  check(near(I[100], 100, 1e-9), 'integ: 10 for 10 s is 100');
  const s = run('smooth("GPS Speed", 1)');
  check(near(s[50], 86, 1e-6) && near(s[0], 38.5, 1e-6), 'smooth: centred, shrinks at the edges');
  const b = run('smooth(\'Brake "Front"\', 0.2)');
  check(b[0] === 1 && b[2] === 1, 'smooth skips missing samples rather than counting them as 0');
  const dl = run('delay("GPS Speed", 0.5)');
  check(Number.isNaN(dl[4]) && dl[5] === 36, 'delay shifts later by whole samples');
}

console.log('errors say where');
function fails(src, re, at){
  try { run(src); }
  catch (err){
    const okMsg = err instanceof MathError && re.test(err.message);
    const okPos = at === undefined || err.pos === at;
    return check(okMsg && okPos, `${JSON.stringify(src)} -> ${err.message} @${err.pos}`);
  }
  return check(false, `${JSON.stringify(src)} should have failed`);
}
fails('', /empty/);
fails('1 +', /ends too early/);
fails('(1 + 2', /expected "\)"/);
fails('"GPS Speed', /closing quote/, 0);
fails('2 Speed1', /missing an operator/, 2);
fails('Speed1 = 2', /==/, 7);
fails('"Nope" * 2', /no channel called "Nope"/, 0);
fails('wobble(1)', /no function/, 0);
fails('clamp(1, 2)', /takes 3 arguments/);
fails('smooth(Speed1, Speed1)', /fixed number of seconds/);
fails('dist', /dist needs/);
fails('1 # 2', /unexpected "#"/, 2);

console.log('editor completion');
{
  const w = wordAt('max("GPS Sp', 11);
  check(w && w.quoted && w.text === 'GPS Sp' && w.start === 4, 'inside an open quote');
  const w2 = wordAt('1 + Spee * 2', 8);
  check(w2 && !w2.quoted && w2.text === 'Spee' && w2.start === 4 && w2.end === 8, 'a bare identifier');
  check(wordAt('"a" + ', 6) === null, 'nothing to complete after an operator');
}

console.log('renaming');
check(renameRef('Slip * 2 + "Slip" - "GPS Slip" + Slipper', 'Slip', 'Wheel slip')
  === '"Wheel slip" * 2 + "Wheel slip" - "GPS Slip" + Slipper',
  'bare and quoted uses are rewritten, look-alikes are not');
check(renameRef('1 +', 'a', 'b') === '1 +', 'an expression that does not parse is left alone');

/* ---- the real thing ------------------------------------------------------------- */
const file = process.argv[2] || 'data/endurance.csv';
if (!existsSync(file)){
  console.log(`\n(skipping the real session: ${file} not found)`);
} else {
  console.log(`\n${file}`);
  const bytes = readFileSync(file);
  const body = WORKER_SRC.replace(/onmessage[\s\S]*$/, '') + '\nreturn parseAll(BUF);';
  // eslint-disable-next-line no-new-func
  const m = new Function('BUF', 'postMessage', body)(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), () => {});
  const t = m.cols[m.names.indexOf('Time')];
  const real = {
    n: m.n, time: t, dist: null,
    channel: name => { const i = m.names.indexOf(name); return i >= 0 ? m.cols[i] : null; },
  };
  const t0 = performance.now();
  const acc = evaluate(parse('smooth(deriv("GPS Speed" / 3.6), 0.25) / g'), real);
  const ms = performance.now() - t0;
  let mx = 0;
  for (const v of acc) if (v === v && Math.abs(v) > mx) mx = Math.abs(v);
  check(mx > 0.5 && mx < 4, `longitudinal g from GPS speed peaks at a plausible ${mx.toFixed(2)} g`);
  check(ms < 250, `${m.n.toLocaleString()} samples in ${ms.toFixed(0)} ms`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
