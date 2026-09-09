import { NextResponse } from 'next/server';
import { passwordMatches, makeSessionCookie } from '../../../lib/auth.js';
import { teamMembers } from '../../../lib/team.js';

/* A wrong password costs a second before it answers. With one shared password and no
   accounts to lock, rate limiting is the only thing standing between the library and a
   dictionary run, and a serverless function has nowhere good to keep a counter. */
const WRONG_ANSWER_DELAY_MS = 1000;

export async function POST(req){
  const { password, name } = await req.json().catch(() => ({}));

  if (!process.env.SITE_PASSWORD){
    return NextResponse.json(
      { error: 'SITE_PASSWORD is not set on this deployment' }, { status: 500 },
    );
  }
  if (!passwordMatches(password)){
    await new Promise(r => setTimeout(r, WRONG_ANSWER_DELAY_MS));
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 });
  }

  /* The roster is the list of valid answers when there is one. It is not a security
     check -- everyone past the password could pick any name on it -- it just keeps the
     uploader column to sixty-odd known spellings instead of freehand. */
  const roster = teamMembers();
  const who = String(name || '').trim().slice(0, 80);
  if (!who) return NextResponse.json({ error: 'Pick your name' }, { status: 400 });
  if (roster.length && !roster.includes(who)){
    return NextResponse.json({ error: 'Pick a name from the list' }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true, name: who });
  res.cookies.set(await makeSessionCookie(who));
  return res;
}
