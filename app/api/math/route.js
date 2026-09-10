import { NextResponse } from 'next/server';
import { sql, ready } from '../../../lib/db.js';
import { listTeamMath, saveTeamMath, deleteTeamMath, rowToMath } from '../../../lib/datasets.js';
import { currentUser } from '../../../lib/session.js';

export const dynamic = 'force-dynamic';

const noDb = () => (!process.env.DATABASE_URL && !process.env.POSTGRES_URL
  ? NextResponse.json({ error: 'not set up yet — this deployment still needs DATABASE_URL' }, { status: 503 })
  : null);

/* The team's shared math channels. The viewer evaluates them itself, in the browser, on
   whatever session is open -- the server only keeps the definitions. */
export async function GET(){
  const bad = noDb(); if (bad) return bad;
  await ready();
  return NextResponse.json({ channels: (await listTeamMath(sql())).map(rowToMath) });
}

/* Share a definition, or update/rename one already shared. The expression is not parsed
   here: the viewer has already evaluated it against a real session before offering to
   share, and the same parser running on the server would add a second copy to keep in
   step for no protection the viewer does not already give. */
export async function POST(req){
  const bad = noDb(); if (bad) return bad;
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const b = await req.json().catch(() => null);
  const name = String(b?.name ?? '').trim().slice(0, 120);
  const expr = String(b?.expr ?? '').trim().slice(0, 4000);
  if (!name || !expr) return NextResponse.json({ error: 'a math channel needs a name and an expression' }, { status: 400 });
  await ready();
  try {
    const row = await saveTeamMath(sql(), {
      name, expr, unit: String(b.unit ?? '').trim().slice(0, 40),
      from: b.from ? String(b.from).trim().slice(0, 120) : '',
    }, me);
    return NextResponse.json({ channel: rowToMath(row) });
  } catch (err){
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}

export async function DELETE(req){
  const bad = noDb(); if (bad) return bad;
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  const name = new URL(req.url).searchParams.get('name');
  if (!name) return NextResponse.json({ error: 'which channel?' }, { status: 400 });
  await ready();
  await deleteTeamMath(sql(), name);
  return NextResponse.json({ ok: true });
}
