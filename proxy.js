import { NextResponse } from 'next/server';
import { isValidSession, SESSION_COOKIE } from './lib/auth.js';

/* Everything is behind the shared password except the login page itself and the
   endpoint that checks it.

   Note what this does *not* cover: blob URLs are served by Vercel Blob, not by this
   app, so a dataset's file is reachable by anyone holding its (unguessable) URL. That
   is the deal the "unlisted" wording in the UI describes -- link-only, not access
   controlled. If that ever needs to be a real boundary, the move is private Blob
   storage with signed URLs minted here. */
export async function proxy(req){
  const { pathname } = req.nextUrl;

  if (pathname === '/login' || pathname === '/api/login') return NextResponse.next();

  if (await isValidSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith('/api/')){
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|logo.webp|favicon.ico).*)'],
};
