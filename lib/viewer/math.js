/* Math channels: a new channel written as an expression over the others.

     "GPS Speed" / 3.6
     smooth(deriv("GPS Speed" / 3.6), 0.3) / g
     (Speed1 - Speed2) / max(Speed1, 1) * 100

   This is the RS3 / i2 feature of the same name. A channel is referenced by name in
   quotes, or bare when its name is a plain identifier. Everything is evaluated a whole
   column at a time -- a node's value is either a number or a column -- so a derivative or
   a moving average is one pass over the data rather than something a per-sample
   interpreter would have to fake with hidden state.

   Nothing here knows about the viewer. It is handed a way to look channels up and gives
   back a column, which is what lets scripts/check-math.mjs test it against the real file. */

export class MathError extends Error {
  constructor(message, pos = -1, end = pos){
    super(message);
    this.pos = pos;
    this.end = end;
  }
}

export const CONSTS = { pi: Math.PI, e: Math.E, g: 9.80665 };
/* Columns the viewer derives rather than logs: the x axes. */
export const BUILTINS = {
  time: 'session time, s',
  dist: 'distance travelled, m',
};

/* What the editor lists, in the order it lists them. `args` is [min, max]. */
export const FUNCS = {
  abs:    { args: [1, 1], sig: 'abs(x)' },
  sqrt:   { args: [1, 1], sig: 'sqrt(x)' },
  pow:    { args: [2, 2], sig: 'pow(x, y)' },
  exp:    { args: [1, 1], sig: 'exp(x)' },
  ln:     { args: [1, 1], sig: 'ln(x)' },
  log10:  { args: [1, 1], sig: 'log10(x)' },
  min:    { args: [1, 99], sig: 'min(a, b, …)' },
  max:    { args: [1, 99], sig: 'max(a, b, …)' },
  clamp:  { args: [3, 3], sig: 'clamp(x, lo, hi)' },
  hypot:  { args: [1, 99], sig: 'hypot(a, b, …)' },
  round:  { args: [1, 1], sig: 'round(x)' },
  floor:  { args: [1, 1], sig: 'floor(x)' },
  ceil:   { args: [1, 1], sig: 'ceil(x)' },
  sign:   { args: [1, 1], sig: 'sign(x)' },
  sin:    { args: [1, 1], sig: 'sin(rad)' },
  cos:    { args: [1, 1], sig: 'cos(rad)' },
  tan:    { args: [1, 1], sig: 'tan(rad)' },
  asin:   { args: [1, 1], sig: 'asin(x)' },
  acos:   { args: [1, 1], sig: 'acos(x)' },
  atan:   { args: [1, 1], sig: 'atan(x)' },
  atan2:  { args: [2, 2], sig: 'atan2(y, x)' },
  rad:    { args: [1, 1], sig: 'rad(deg)' },
  deg:    { args: [1, 1], sig: 'deg(rad)' },
  if:     { args: [3, 3], sig: 'if(cond, a, b)', doc: 'a where cond is true, else b' },
  isnan:  { args: [1, 1], sig: 'isnan(x)', doc: '1 where x has no data' },
  deriv:  { args: [1, 1], sig: 'deriv(x)', doc: 'rate of change per second' },
  integ:  { args: [1, 1], sig: 'integ(x)', doc: 'running integral over time' },
  smooth: { args: [2, 2], sig: 'smooth(x, s)', doc: 'moving average over s seconds' },
  delay:  { args: [2, 2], sig: 'delay(x, s)', doc: 'shift x later by s seconds' },
};
/* Spelled the way people coming from other tools will type them. */
const ALIAS = { log: 'ln', derivative: 'deriv', integral: 'integ', avg: 'smooth', shift: 'delay' };

/* ---- lexing ------------------------------------------------------------------ */

const TWO = ['**', '<=', '>=', '==', '!=', '&&', '||'];
const ONE = '+-*/%^(),?:<>!';

function lex(src){
  const out = [];
  let i = 0;
  while (i < src.length){
    const c = src[i];
    if (/\s/.test(c)){ i++; continue; }
    if (/[0-9.]/.test(c)){
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new MathError(`unexpected "${c}"`, i, i + 1);
      out.push({ t: 'num', v: +m[0], pos: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'"){
      const close = src.indexOf(c, i + 1);
      if (close < 0) throw new MathError('missing closing quote', i, src.length);
      out.push({ t: 'str', v: src.slice(i + 1, close), pos: i, end: close + 1 });
      i = close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)){
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      out.push({ t: 'id', v: m[0], pos: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO.includes(two)){
      out.push({ t: 'op', v: two, pos: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (c === '=') throw new MathError('use == to compare', i, i + 1);
    if (ONE.includes(c)){
      out.push({ t: 'op', v: c, pos: i, end: i + 1 });
      i++;
      continue;
    }
    throw new MathError(`unexpected "${c}"`, i, i + 1);
  }
  out.push({ t: 'end', pos: src.length, end: src.length });
  return out;
}

const describe = tok =>
  tok.t === 'end' ? 'the end' :
  tok.t === 'num' ? `number ${tok.v}` :
  tok.t === 'str' ? `"${tok.v}"` : `"${tok.v}"`;

/* ---- parsing: Pratt, with the precedence anyone who has used a calculator expects -- */

/* [left, right] binding power. ^ is right-associative and binds tighter than unary
   minus, so -x^2 is -(x^2) the way it is on paper. */
const INFIX = {
  '?': [2, 1],
  '||': [3, 4], '&&': [5, 6],
  '==': [7, 8], '!=': [7, 8],
  '<': [9, 10], '<=': [9, 10], '>': [9, 10], '>=': [9, 10],
  '+': [11, 12], '-': [11, 12],
  '*': [13, 14], '/': [13, 14], '%': [13, 14],
  '^': [18, 17], '**': [18, 17],
};
const PREFIX_BP = 15;

export function parse(src){
  const toks = lex(src);
  let k = 0;
  const peek = () => toks[k];
  const next = () => toks[k++];
  const isOp = (tok, v) => tok.t === 'op' && tok.v === v;
  const expect = v => {
    const tok = next();
    if (!isOp(tok, v)) throw new MathError(`expected "${v}" but found ${describe(tok)}`, tok.pos, tok.end);
    return tok;
  };

  if (toks[0].t === 'end') throw new MathError('empty expression', 0, 0);
  const ast = expr(0);
  const tail = peek();
  if (tail.t !== 'end') throw new MathError(`unexpected ${describe(tail)}`, tail.pos, tail.end);
  return ast;

  function expr(minBp){
    let lhs = prefix();
    for (;;){
      const tok = peek();
      if (tok.t === 'end') break;
      if (tok.t !== 'op')
        throw new MathError(`missing an operator before ${describe(tok)}`, tok.pos, tok.end);
      const bp = INFIX[tok.v];
      if (!bp || bp[0] < minBp) break;
      next();
      if (tok.v === '?'){
        const a = expr(0);
        expect(':');
        const b = expr(bp[1]);
        lhs = { k: 'fn', name: 'if', args: [lhs, a, b], pos: tok.pos, end: tok.end };
        continue;
      }
      const rhs = expr(bp[1]);
      lhs = { k: 'bin', op: tok.v === '**' ? '^' : tok.v, a: lhs, b: rhs, pos: tok.pos, end: tok.end };
    }
    return lhs;
  }

  function prefix(){
    const tok = next();
    if (tok.t === 'num') return { k: 'num', v: tok.v };
    if (tok.t === 'str') return { k: 'ch', name: tok.v, pos: tok.pos, end: tok.end };
    if (tok.t === 'id'){
      if (!isOp(peek(), '(')) return { k: 'id', name: tok.v, pos: tok.pos, end: tok.end };
      const lower = tok.v.toLowerCase();
      const name = ALIAS[lower] || lower;
      const F = FUNCS[name];
      if (!F) throw new MathError(`no function called ${tok.v}()`, tok.pos, tok.end);
      next();
      const args = [];
      if (!isOp(peek(), ')')){
        for (;;){
          args.push(expr(0));
          if (!isOp(peek(), ',')) break;
          next();
        }
      }
      const close = expect(')');
      const [lo, hi] = F.args;
      if (args.length < lo || args.length > hi){
        const want = lo === hi ? `${lo}` : hi >= 99 ? `at least ${lo}` : `${lo}–${hi}`;
        throw new MathError(`${F.sig} takes ${want} argument${want === '1' ? '' : 's'}, not ${args.length}`,
          tok.pos, close.end);
      }
      return { k: 'fn', name, args, pos: tok.pos, end: close.end };
    }
    if (isOp(tok, '(')){
      const e = expr(0);
      expect(')');
      return e;
    }
    if (isOp(tok, '-') || isOp(tok, '+') || isOp(tok, '!'))
      return { k: 'un', op: tok.v, a: expr(PREFIX_BP), pos: tok.pos, end: tok.end };
    if (tok.t === 'end') throw new MathError('the expression ends too early', tok.pos, tok.end);
    throw new MathError(`unexpected ${describe(tok)}`, tok.pos, tok.end);
  }
}

/* Every name the expression refers to, for dependency tracking. Bare identifiers are
   included even when they turn out to be constants -- the resolver decides. */
export function refs(ast, out = new Set()){
  if (!ast) return out;
  if (ast.k === 'ch' || ast.k === 'id') out.add(ast.name);
  if (ast.a) refs(ast.a, out);
  if (ast.b) refs(ast.b, out);
  if (ast.args) ast.args.forEach(a => refs(a, out));
  return out;
}

/* ---- evaluation -----------------------------------------------------------------

   env: { n, time, dist, channel(name, quoted) -> column | null }
   channel() may throw a MathError of its own (a circular reference, say); it is given
   the position of the name that caused it on the way out.                            */

export function evaluate(ast, env){
  const { n } = env;
  const res = ev(ast);
  const out = new Float64Array(n);
  if (typeof res === 'number') out.fill(res);
  else out.set(res.length === n ? res : res.subarray(0, n));
  return out;

  function ev(node){
    switch (node.k){
      case 'num': return node.v;
      case 'ch':
      case 'id': return lookup(node);
      case 'un': {
        const a = ev(node.a);
        if (node.op === '-') return lift1(a, x => -x, n);
        if (node.op === '!') return lift1(a, x => (x !== x ? NaN : x ? 0 : 1), n);
        return a;
      }
      case 'bin': return lift2(ev(node.a), ev(node.b), BIN[node.op], n);
      case 'fn': return call(node);
    }
    throw new MathError('internal: unknown node');
  }

  function lookup(node){
    let col;
    try { col = env.channel(node.name, node.k === 'ch'); }
    catch (err){
      if (err instanceof MathError && err.pos < 0){ err.pos = node.pos; err.end = node.end; }
      throw err;
    }
    if (col) return col;
    if (node.k === 'id'){
      if (node.name in CONSTS) return CONSTS[node.name];
      if (node.name === 'time') return env.time;
      if (node.name === 'dist'){
        if (!env.dist) throw new MathError('dist needs the speed or position channels set', node.pos, node.end);
        return env.dist;
      }
    }
    throw new MathError(`no channel called "${node.name}"`, node.pos, node.end);
  }

  function scalarArg(node, what){
    const v = ev(node);
    if (typeof v !== 'number' || !(v >= 0))
      throw new MathError(`${what} has to be a fixed number of seconds`, node.pos ?? -1, node.end ?? -1);
    return v;
  }

  function call(node){
    const { name, args } = node;
    const f1 = UNARY[name];
    if (f1) return lift1(ev(args[0]), f1, n);
    switch (name){
      case 'pow': return lift2(ev(args[0]), ev(args[1]), Math.pow, n);
      case 'atan2': return lift2(ev(args[0]), ev(args[1]), Math.atan2, n);
      case 'min': return args.map(ev).reduce((a, b) => lift2(a, b, Math.min, n));
      case 'max': return args.map(ev).reduce((a, b) => lift2(a, b, Math.max, n));
      case 'hypot': return args.map(ev).reduce((a, b) => lift2(a, b, Math.hypot, n), 0);
      case 'clamp': {
        const [x, lo, hi] = args.map(ev);
        return lift2(lift2(x, lo, Math.max, n), hi, Math.min, n);
      }
      case 'if': {
        const [c, a, b] = args.map(ev);
        return lift3(c, a, b, (c, a, b) => (c !== c ? NaN : c ? a : b), n);
      }
      case 'deriv': return deriv(ev(args[0]), env);
      case 'integ': return integ(ev(args[0]), env);
      case 'smooth': {
        const x = ev(args[0]);
        return smooth(x, scalarArg(args[1], 'smooth()’s window'), env);
      }
      case 'delay': {
        const x = ev(args[0]);
        return delay(x, scalarArg(args[1], 'delay()’s shift'), env);
      }
    }
    throw new MathError(`no function called ${name}()`, node.pos, node.end);
  }
}

const cmp = f => (x, y) => (x !== x || y !== y ? NaN : f(x, y) ? 1 : 0);
const BIN = {
  '+': (x, y) => x + y,
  '-': (x, y) => x - y,
  '*': (x, y) => x * y,
  '/': (x, y) => x / y,
  '%': (x, y) => x % y,
  '^': Math.pow,
  '<': cmp((x, y) => x < y), '<=': cmp((x, y) => x <= y),
  '>': cmp((x, y) => x > y), '>=': cmp((x, y) => x >= y),
  '==': cmp((x, y) => x === y), '!=': cmp((x, y) => x !== y),
  '&&': cmp((x, y) => x && y), '||': cmp((x, y) => x || y),
};
const UNARY = {
  abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, ln: Math.log, log10: Math.log10,
  round: Math.round, floor: Math.floor, ceil: Math.ceil, sign: Math.sign,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  rad: x => x * Math.PI / 180, deg: x => x * 180 / Math.PI,
  isnan: x => (x !== x ? 1 : 0),
};

function lift1(a, f, n){
  if (typeof a === 'number') return f(a);
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = f(a[i]);
  return o;
}
function lift2(a, b, f, n){
  const sa = typeof a === 'number', sb = typeof b === 'number';
  if (sa && sb) return f(a, b);
  const o = new Float64Array(n);
  if (sa) for (let i = 0; i < n; i++) o[i] = f(a, b[i]);
  else if (sb) for (let i = 0; i < n; i++) o[i] = f(a[i], b);
  else for (let i = 0; i < n; i++) o[i] = f(a[i], b[i]);
  return o;
}
function lift3(a, b, c, f, n){
  if (typeof a === 'number' && typeof b === 'number' && typeof c === 'number') return f(a, b, c);
  const at = (v, i) => (typeof v === 'number' ? v : v[i]);
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = f(at(a, i), at(b, i), at(c, i));
  return o;
}

/* ---- signal functions: these are why evaluation is by column --------------------- */

const meanDt = ({ time: t, n }) => (n > 1 ? (t[n - 1] - t[0]) / (n - 1) : 0) || 0.05;

/* Central difference against the real timestamps, so a dropped sample does not read as
   a spike. */
function deriv(x, { time: t, n }){
  if (typeof x === 'number') return 0;
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++){
    const a = i > 0 ? i - 1 : 0, b = i < n - 1 ? i + 1 : n - 1;
    const dt = t[b] - t[a];
    o[i] = dt > 0 ? (x[b] - x[a]) / dt : NaN;
  }
  return o;
}

/* Trapezoidal. A gap in the data contributes nothing rather than poisoning every sample
   after it. */
function integ(x, { time: t, n }){
  const o = new Float64Array(n);
  let acc = 0;
  for (let i = 1; i < n; i++){
    const v0 = typeof x === 'number' ? x : x[i - 1];
    const v1 = typeof x === 'number' ? x : x[i];
    if (v0 === v0 && v1 === v1) acc += (v0 + v1) / 2 * (t[i] - t[i - 1]);
    o[i] = acc;
  }
  return o;
}

/* Centred moving average. Prefix sums make it one pass whatever the window, and missing
   samples are left out of the mean rather than counted as zero. */
function smooth(x, s, env){
  if (typeof x === 'number') return x;
  const { n } = env;
  const half = Math.max(0, Math.round(s / meanDt(env) / 2));
  const ps = new Float64Array(n + 1), pc = new Float64Array(n + 1);
  for (let i = 0; i < n; i++){
    const v = x[i], ok = v === v;
    ps[i + 1] = ps[i] + (ok ? v : 0);
    pc[i + 1] = pc[i] + (ok ? 1 : 0);
  }
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++){
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    const c = pc[b] - pc[a];
    o[i] = c ? (ps[b] - ps[a]) / c : NaN;
  }
  return o;
}

function delay(x, s, env){
  if (typeof x === 'number') return x;
  const { n } = env;
  const k = Math.round(s / meanDt(env));
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++){
    const j = i - k;
    o[i] = j >= 0 && j < n ? x[j] : NaN;
  }
  return o;
}

/* ---- editor helpers ------------------------------------------------------------ */

/* The partial name under the caret, so the editor can offer completions: inside an open
   quote that is everything since the quote; otherwise the identifier being typed. */
export function wordAt(src, caret){
  let q = -1, qc = '';
  for (let i = 0; i < caret; i++){
    const c = src[i];
    if (q < 0){ if (c === '"' || c === "'"){ q = i; qc = c; } }
    else if (c === qc) q = -1;
  }
  if (q >= 0){
    const close = src.indexOf(qc, caret);
    return { start: q, end: close < 0 ? caret : close + 1, text: src.slice(q + 1, caret), quoted: true };
  }
  const m = /[A-Za-z_][A-Za-z0-9_]*$/.exec(src.slice(0, caret));
  if (!m) return null;
  const after = /^[A-Za-z0-9_]*/.exec(src.slice(caret))[0];
  return { start: caret - m[0].length, end: caret + after.length, text: m[0], quoted: false };
}

/* How a channel name is written into an expression. */
export const quoteName = name => (name.includes('"') ? `'${name}'` : `"${name}"`);

/* Renaming a math channel rewrites the expressions that use it. Done on the parse tree
   rather than with a regex, so "Speed" inside "GPS Speed" or a function called speed()
   is never touched. An expression that does not parse is left as it is. */
export function renameRef(src, from, to){
  let ast;
  try { ast = parse(src); } catch { return src; }
  const hits = [];
  (function walk(a){
    if (!a) return;
    if ((a.k === 'ch' || a.k === 'id') && a.name === from) hits.push(a);
    walk(a.a); walk(a.b);
    if (a.args) a.args.forEach(walk);
  })(ast);
  let out = src;
  for (const h of hits.sort((x, y) => y.pos - x.pos))
    out = out.slice(0, h.pos) + quoteName(to) + out.slice(h.end);
  return out;
}
