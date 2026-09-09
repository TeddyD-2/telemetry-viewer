import { notFound } from 'next/navigation';
import { sql, ready } from '../../../lib/db.js';
import { getDataset, rowToDataset } from '../../../lib/datasets.js';
import StoredSession from '../../../components/StoredSession.jsx';
import { currentUser } from '../../../lib/session.js';

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

  /* Ownership is settled here, on the server, from the signed-in name -- the same check
     the API makes when an edit is actually attempted. */
  return <StoredSession dataset={rowToDataset(row, await currentUser())} />;
}
