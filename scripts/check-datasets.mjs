/* Runs the library's SQL against a real Postgres, in-process.

   The queries in lib/datasets.js are the part of this app that nobody can eyeball for
   correctness -- a typo'd column or a boolean that arrives as a string does not fail
   the build, it fails in the paddock. PGlite is Postgres compiled to WASM, so this
   exercises the actual statements, the actual schema and the actual types without
   anyone provisioning a database first.

     node scripts/check-datasets.mjs                                                   */

import { PGlite } from '@electric-sql/pglite';
import {
  SCHEMA, listDatasets, getDataset, insertDataset, updateDataset, deleteDataset, rowToDataset,
  listNotes, setNote, rowToNote, listTeamMath, saveTeamMath, deleteTeamMath, rowToMath,
} from '../lib/datasets.js';

const db = new PGlite();

/* Neon's client is a tagged template that returns rows. Give the queries the same shape
   over PGlite so they run here exactly as they run in production. */
const sql = async (strings, ...values) => {
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
  const { rows } = await db.query(text, values);
  return rows;
};

let failures = 0;
function check(ok, what){
  if (ok) console.log(`  ok    ${what}`);
  else { console.log(`  FAIL  ${what}`); failures++; }
  return ok;
}

for (const stmt of SCHEMA) await db.exec(stmt);
check(true, 'schema applies');
for (const stmt of SCHEMA) await db.exec(stmt);
check(true, 'schema is idempotent (a second deploy does not fail)');

const base = {
  title: 'Michigan endurance', description: 'long run, brake temps',
  uploader: 'Teddy Duncker', csvUrl: 'https://x.public.blob.vercel-storage.com/a.csv',
  csvName: 'endurance.csv', csvBytes: 83021163,
  binUrl: 'https://x.public.blob.vercel-storage.com/a.tvb', binBytes: 14680064,
  samples: 36460, channels: 226, laps: 0, durationS: 1822.95,
  session: 'Michigan', vehicle: 'arg26', racer: 'comp', recordedAt: 'Saturday, June 20, 2026 12:03 PM',
};

const ME = 'Teddy Duncker', THEM = 'Priya Nair';
/* Roles travel as channel names plus which occurrence, never as column indices. */
const ROLES_AT_IMPORT = { speed: { name: 'GPS Speed', nth: 0 }, lat: { name: 'GPS Latitude' } };
/* jsonb does not preserve key order -- Postgres stores {name,nth} back as {nth,name} --
   so these have to be compared by value. Anything that diffs roles by serialising them
   would see a spurious change on every read. */
const sameRoles = (a, b) => {
  if (!a || !b) return a === b;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k =>
    b[k] && a[k].name === b[k].name && (a[k].nth ?? 0) === (b[k].nth ?? 0));
};
const mine = await insertDataset(sql, {
  ...base, id: 'aaa1', listed: true, roles: ROLES_AT_IMPORT,
});
check(sameRoles(mine.roles, ROLES_AT_IMPORT), 'roles round-trip as jsonb');
const theirs = await insertDataset(sql, {
  ...base, id: 'bbb2', title: 'Autocross practice', uploader: THEM, listed: true,
});
await insertDataset(sql, {
  ...base, id: 'ccc3', title: 'Scratch run', uploader: THEM, listed: false,
});
await insertDataset(sql, {
  ...base, id: 'ddd4', title: 'My rough run', listed: false,
});

check(mine.id === 'aaa1' && mine.title === 'Michigan endurance', 'insert returns the row');
check(mine.listed === true, 'listed round-trips as a boolean, not a string');
check(Number(mine.csv_bytes) === 83021163, 'an 83 MB byte count survives (bigint)');
check(Math.abs(mine.duration_s - 1822.95) < 1e-9, 'duration keeps its precision');
check(mine.created_at instanceof Date, 'created_at is set by the database');

const anon = await listDatasets(sql, '');
check(anon.length === 2, `signed-in stranger sees only shared sessions (${anon.length} of 4)`);
check(!anon.some(r => r.id === 'ccc3' || r.id === 'ddd4'), 'unlisted sessions stay out of the list');

const forMe = await listDatasets(sql, ME);
check(forMe.length === 3, `uploader also sees their own unlisted session (${forMe.length} of 4)`);
check(forMe.some(r => r.id === 'ddd4'), 'my unlisted session is in my list');
check(!forMe.some(r => r.id === 'ccc3'), "someone else's unlisted session is not");

check(forMe[0].created_at >= forMe[forMe.length - 1].created_at, 'newest first');

const dto = rowToDataset(mine, ME);
check(dto.mine === true, 'rowToDataset marks my own session');
check(rowToDataset(theirs, ME).mine === false, "and does not mark someone else's");
check(!('owner_token' in dto) && !('ownerToken' in dto), 'the retired owner token never reaches the browser');
check(dto.csvBytes === 83021163 && typeof dto.csvBytes === 'number', 'byte counts reach the browser as numbers');

const patched = await updateDataset(sql, 'aaa1', {
  title: 'Michigan endurance — rear brake test',
  description: base.description, uploader: base.uploader, listed: false, laps: 22,
  roles: mine.roles,
});
check(sameRoles(patched.roles, ROLES_AT_IMPORT),
  'a lap-count writeback does not clear the roles settled at import');
check(patched.uploader === ME, 'editing a session does not reassign its credit');
/* Editing is open to anyone signed in, but the credit on a session is not a permission
   and must survive being edited by someone else. */
const byOther = await updateDataset(sql, 'bbb2', {
  title: 'Autocross practice — retitled by a teammate',
  description: '', uploader: theirs.uploader, listed: true, laps: 7, roles: null,
});
check(byOther.uploader === THEM, "a teammate's edit leaves the original uploader credited");
check(patched.title.endsWith('rear brake test'), 'update changes the title');
check(patched.listed === false, 'update can unshare a session');
check(patched.laps === 22, 'the viewer can fill in the lap count later');
check((await listDatasets(sql, '')).length === 1, 'unsharing removes it from the shared list');

await deleteDataset(sql, 'aaa1');
check((await getDataset(sql, 'aaa1')) === null, 'delete removes the row');
check((await getDataset(sql, 'nope')) === null, 'a missing id reads as null, not a crash');

/* The unique id the route mints has to actually fit the column. */
const wide = await insertDataset(sql, {
  ...base, id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
  listed: true,
  description: 'x'.repeat(2000), title: 'y'.repeat(200),
});
check(wide.description.length === 2000 && wide.title.length === 200, 'the longest allowed text fits');

/* ---- channel notes ---- */
const n1 = await setNote(sql, 'LateralAcc', 'reads ~26% high against v * yaw rate', ME);
check(n1.note.startsWith('reads') && n1.updated_by === ME, 'a note is stored with its author');
const n2 = await setNote(sql, 'LateralAcc', 'reads ~26% high — recalibrated for Sunday', THEM);
check(n2.updated_by === THEM && n2.note.endsWith('Sunday'), 'writing again replaces the note and its author');
await setNote(sql, 'GPS Speed', 'use #2 on 2025 exports', ME);
check((await listNotes(sql)).length === 2, 'one row per channel');
check((await setNote(sql, 'GPS Speed', '', ME)) === null && (await listNotes(sql)).length === 1,
  'clearing the text deletes the note');
check(rowToNote(n2).updatedBy === THEM && 'updatedAt' in rowToNote(n2), 'notes reach the browser in camelCase');

/* ---- team math channels ---- */
const m1 = await saveTeamMath(sql, { name: 'Wheel slip', unit: '%', expr: '("Speed1" - "Speed2") / max("Speed1", 1) * 100' }, ME);
check(m1.created_by === ME && m1.unit === '%', 'a math channel is shared with its author');
const m2 = await saveTeamMath(sql, { name: 'Wheel slip', unit: '%', expr: '"Speed1" - "Speed2"' }, THEM);
check(m2.created_by === ME && m2.updated_by === THEM && m2.expr === '"Speed1" - "Speed2"',
  'sharing an edit updates it and keeps the original author');
const m3 = await saveTeamMath(sql, { name: 'Slip ratio', unit: '%', expr: m2.expr, from: 'Wheel slip' }, THEM);
const all = await listTeamMath(sql);
check(m3.name === 'Slip ratio' && all.length === 1 && all[0].created_by === ME, 'a rename moves the row rather than adding one');
await saveTeamMath(sql, { name: 'Long g', unit: 'g', expr: 'deriv("GPS Speed" / 3.6) / g' }, ME);
let conflict = null;
try { await saveTeamMath(sql, { name: 'Long g', unit: '', expr: '1', from: 'Slip ratio' }, ME); }
catch (err){ conflict = err; }
check(conflict && conflict.status === 409 && (await listTeamMath(sql)).length === 2,
  'renaming onto a name the team already uses is refused, and nothing is lost');
await deleteTeamMath(sql, 'Long g');
check((await listTeamMath(sql)).map(r => r.name).join() === 'Slip ratio', 'delete removes one definition');
check(rowToMath(m3).createdBy === ME, 'math channels reach the browser in camelCase');

await db.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
