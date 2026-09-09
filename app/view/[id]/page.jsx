import { notFound } from 'next/navigation';
import { sql, ready } from '../../../lib/db.js';
import { getDataset, rowToDataset } from '../../../lib/datasets.js';
import StoredSession from '../../../components/StoredSession.jsx';
import { teamMembers } from '../../../lib/team.js';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }){
  const { id } = await params;
  await ready();
  const row = await getDataset(sql(), id);
  return { title: row ? `${row.title} — Telemetry Viewer` : 'Telemetry Viewer' };
}

export default async function ViewPage({ params }){
  const { id } = await params;
  await ready();
  const row = await getDataset(sql(), id);
  if (!row) notFound();

  /* The owner check is the browser's job -- the token lives in localStorage and never
     reaches the server on a page load -- so the row goes down without it and
     StoredSession decides whether to offer the edit controls. */
  return <StoredSession dataset={rowToDataset(row)} members={teamMembers()} />;
}
