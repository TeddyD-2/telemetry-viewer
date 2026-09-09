/* One shared password for the whole site, no accounts.

   The team is twenty-odd people who already share a garage; making everyone hold an
   account to look at a lap trace would be friction for no security we would actually
   get. What the password buys is that the library is not on the open web.

   The cookie is an HMAC over an expiry, not the password itself, so a stolen cookie
   cannot be replayed forever and the password never sits in browser storage. Everything
   here runs on Web Crypto so it works unchanged in middleware. */

const COOKIE = 'tv_session';
const TTL_DAYS = 30;

const enc = new TextEncoder();

function secret(){
  const s = process.env.AUTH_SECRET || process.env.SITE_PASSWORD;
  if (!s) throw new Error('AUTH_SECRET (or SITE_PASSWORD) is not set');
  return s;
}

/* base64url without Buffer: this runs in the proxy, which Next may execute on the Edge
   runtime where Node globals are not guaranteed. Web Crypto and btoa always are. */
function base64url(bytes){
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(msg){
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return base64url(new Uint8Array(sig));
}

/* Length-independent compare, so a wrong password cannot be narrowed down by timing. */
function safeEqual(a, b){
  const A = enc.encode(a), B = enc.encode(b);
  let diff = A.length ^ B.length;
  for (let i = 0; i < Math.max(A.length, B.length); i++) diff |= (A[i] || 0) ^ (B[i] || 0);
  return diff === 0;
}

export function passwordMatches(input){
  const expected = process.env.SITE_PASSWORD;
  if (!expected) return false;
  return safeEqual(String(input || ''), expected);
}

export async function makeSessionCookie(){
  const expires = Date.now() + TTL_DAYS * 864e5;
  const value = `${expires}.${await hmac(String(expires))}`;
  return {
    name: COOKIE,
    value,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: TTL_DAYS * 86400,
  };
}

export async function isValidSession(value){
  if (!value) return false;
  const [expires, sig] = String(value).split('.');
  if (!expires || !sig) return false;
  if (!(Number(expires) > Date.now())) return false;
  return safeEqual(sig, await hmac(expires));
}

export const SESSION_COOKIE = COOKIE;
