import { NextResponse } from 'next/server';
import { sql, ready } from '../../../lib/db.js';
import { listNotes, setNote, rowToNote } from '../../../lib/datasets.js';
import { currentUser } from '../../../lib/session.js';

export const dynamic = 'force-dynamic';

const noDb = () => (!process.env.DATABASE_URL && !process.env.POSTGRES_URL
  ? NextResponse.json({ error: 'not set up yet — this deployment still needs DATABASE_URL' }, { status: 503 })
  : null);

/* Every note the team has written, keyed by channel name. A few hundred short strings at
   most, so the viewer takes the lot once rather than asking per channel. */
export async function GET(){
  const bad = noDb(); if (bad) return bad;
  await ready();
  return NextResponse.json({ notes: (await listNotes(sql())).map(rowToNote) });
}

/* Write or clear the note on one channel. Anyone signed in; the author is recorded and
   shown under the note, as attribution. */
export async function PUT(req){
  const bad = noDb(); if (bad) return bad;
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const b = await req.json().catch(() => null);
  const channel = String(b?.channel ?? '').trim().slice(0, 200);
  if (!channel) return NextResponse.json({ error: 'which channel?' }, { status: 400 });
  const note = String(b?.note ?? '').trim().slice(0, 2000);
  await ready();
  const row = await setNote(sql(), channel, note, me);
  return NextResponse.json({ note: row ? rowToNote(row) : null });
}
