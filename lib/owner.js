/* Who uploaded a session, without accounts.

   On the first upload the browser mints a random token, keeps it in localStorage and
   sends it with the dataset. It is not an identity -- clearing site data loses it, and
   a second browser is a second "person". What it buys is worth having anyway: your own
   unlisted sessions show up in the library, and nobody else can retitle or delete the
   session you just uploaded by accident.

   Anything that actually needs to be secured is secured by the site password. */

const KEY = 'tv_owner_token';

export function ownerToken(){
  if (typeof window === 'undefined') return '';
  try {
    let t = localStorage.getItem(KEY);
    if (!t){
      t = crypto.randomUUID();
      localStorage.setItem(KEY, t);
    }
    return t;
  } catch {
    /* Private windows and blocked site data: uploads still work, they just will not be
       attributed back to this browser later. */
    return '';
  }
}

const NAME_KEY = 'tv_uploader_name';

export function rememberedName(){
  if (typeof window === 'undefined') return '';
  try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; }
}

export function rememberName(name){
  try { localStorage.setItem(NAME_KEY, name); } catch { /* not important enough to fail on */ }
}
