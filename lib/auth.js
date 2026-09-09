/* One shared password for the whole site, plus a name.

   The team is sixty-odd people who already share a garage; making everyone hold an
   account to look at a lap trace would be friction for no security we would actually
   get. What the password buys is that the library is not on the open web. What the name
   buys is that a session has an author, and that your own uploads follow you to your
   phone instead of being stranded in one browser's local storage.

   The name is self-asserted -- anyone with the password can sign in as anyone -- so it
   is an attribution, not an identity. It is carried inside the signed cookie rather
   than sent alongside it, so it cannot be edited client-side without the secret, which
   is enough to stop the accidental case: editing or deleting a session that is not
   yours because a stale field said it was.

   Everything here runs on Web Crypto so it works unchanged in the proxy. */

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
function b64url(bytes){
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s){
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(pad + '==='.slice((pad.length + 3) % 4)), c => c.charCodeAt(0));
}

async function hmac(msg){
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg))));
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

export async function makeSessionCookie(name){
  const expires = Date.now() + TTL_DAYS * 864e5;
  const who = b64url(enc.encode(String(name || '').slice(0, 80)));
  const body = `${expires}.${who}`;
  return {
    name: COOKIE,
    value: `${body}.${await hmac(body)}`,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: TTL_DAYS * 86400,
  };
}

/* Returns the signed-in name, or null when the cookie is missing, expired or forged. */
export async function readSession(value){
  if (!value) return null;
  const parts = String(value).split('.');
  if (parts.length !== 3) return null;
  const [expires, who, sig] = parts;
  if (!(Number(expires) > Date.now())) return null;
  if (!safeEqual(sig, await hmac(`${expires}.${who}`))) return null;
  try {
    return { name: new TextDecoder().decode(unb64url(who)) };
  } catch {
    return null;
  }
}

export const isValidSession = async value => !!(await readSession(value));

export const SESSION_COOKIE = COOKIE;
