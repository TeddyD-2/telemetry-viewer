import { NextResponse } from 'next/server';
import { passwordMatches, makeSessionCookie } from '../../../lib/auth.js';

/* A wrong password costs a second before it answers. With one shared password and no
   accounts to lock, rate limiting is the only thing standing between the library and a
   dictionary run, and a serverless function has nowhere good to keep a counter. */
const WRONG_ANSWER_DELAY_MS = 1000;

export async function POST(req){
  const { password } = await req.json().catch(() => ({}));

  if (!process.env.SITE_PASSWORD){
    return NextResponse.json(
      { error: 'SITE_PASSWORD is not set on this deployment' }, { status: 500 },
    );
  }
  if (!passwordMatches(password)){
    await new Promise(r => setTimeout(r, WRONG_ANSWER_DELAY_MS));
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(await makeSessionCookie());
  return res;
}
