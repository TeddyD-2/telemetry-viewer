/* Every query the app makes, in one place, each taking the tagged-template `sql` it
   should run against. The routes pass Neon's; scripts/check-datasets.mjs passes an
   in-process Postgres, which is how this SQL gets exercised without provisioning a
   database first. */

export const SCHEMA = [
  `create table if not exists datasets (
     id            text primary key,
     title         text not null,
     description   text not null default '',
     uploader      text not null default '',
     listed        boolean not null default false,
     owner_token   text not null,
     csv_url       text not null,
     csv_name      text not null default '',
     csv_bytes     bigint not null default 0,
     bin_url       text not null,
     bin_bytes     bigint not null default 0,
     samples       integer,
     channels      integer,
     laps          integer,
     duration_s    double precision,
     session_name  text not null default '',
     vehicle       text not null default '',
     racer         text not null default '',
     recorded_at   text not null default '',
     created_at    timestamptz not null default now()
   )`,
  `create index if not exists datasets_listed_idx on datasets (listed, created_at desc)`,
  /* Added after the first sessions were uploaded, so it arrives as an alter rather than
     part of the create. Both run every boot and both are no-ops once applied. */
  `alter table datasets add column if not exists roles jsonb`,
  /* owner_token is retired: editing is open to anyone signed in, so nothing reads it any
     more. The column stays -- dropping it would throw away the only record of which
     browser uploaded the earliest sessions, for no gain -- but new rows no longer fill
     it, so it needs a default. */
  `alter table datasets alter column owner_token set default ''`,
  /* Notes on channels, shared by the whole team. Keyed by channel name rather than by
     session: "LateralAcc reads about 26% high" is true of the logger, on every run. */
  `create table if not exists channel_notes (
     channel     text primary key,
     note        text not null,
     updated_by  text not null default '',
     updated_at  timestamptz not null default now()
   )`,
  /* Math channels shared with the team. Personal ones stay in the browser that wrote
     them; these reach everyone signed in, on every session that has their inputs. */
  `create table if not exists math_channels (
     name        text primary key,
     unit        text not null default '',
     expr        text not null,
     created_by  text not null default '',
     updated_by  text not null default '',
     updated_at  timestamptz not null default now()
   )`,
];

const LIMIT = 500;

/* Shared sessions, plus any unlisted ones the signed-in person uploaded. */
export function listDatasets(sql, me){
  return me
    ? sql`select * from datasets
          where listed = true or uploader = ${me}
          order by created_at desc limit ${LIMIT}`
    : sql`select * from datasets
          where listed = true
          order by created_at desc limit ${LIMIT}`;
}

export async function getDataset(sql, id){
  const rows = await sql`select * from datasets where id = ${id}`;
  return rows[0] || null;
}

export async function insertDataset(sql, d){
  const rows = await sql`
    insert into datasets (
      id, title, description, uploader, listed,
      csv_url, csv_name, csv_bytes, bin_url, bin_bytes,
      samples, channels, laps, duration_s,
      session_name, vehicle, racer, recorded_at, roles
    ) values (
      ${d.id}, ${d.title}, ${d.description}, ${d.uploader}, ${d.listed},
      ${d.csvUrl}, ${d.csvName}, ${d.csvBytes}, ${d.binUrl}, ${d.binBytes},
      ${d.samples}, ${d.channels}, ${d.laps}, ${d.durationS},
      ${d.session}, ${d.vehicle}, ${d.racer}, ${d.recordedAt},
      ${d.roles ? JSON.stringify(d.roles) : null}
    ) returning *`;
  return rows[0];
}

export async function updateDataset(sql, id, d){
  const rows = await sql`
    update datasets set
      title       = ${d.title},
      description = ${d.description},
      uploader    = ${d.uploader},
      listed      = ${d.listed},
      laps        = ${d.laps},
      roles       = ${d.roles === undefined ? null : JSON.stringify(d.roles)}
    where id = ${id} returning *`;
  return rows[0];
}

export function deleteDataset(sql, id){
  return sql`delete from datasets where id = ${id}`;
}

/* ---- channel notes ---- */

export function listNotes(sql){
  return sql`select * from channel_notes order by channel`;
}

/* An empty note is no note: clearing the text deletes the row rather than leaving an
   empty tooltip behind. Returns the stored row, or null once deleted. */
export async function setNote(sql, channel, note, by){
  if (!note){
    await sql`delete from channel_notes where channel = ${channel}`;
    return null;
  }
  const rows = await sql`
    insert into channel_notes (channel, note, updated_by, updated_at)
    values (${channel}, ${note}, ${by}, now())
    on conflict (channel) do update
      set note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
    returning *`;
  return rows[0];
}

export const rowToNote = r => ({
  channel: r.channel, note: r.note, updatedBy: r.updated_by, updatedAt: r.updated_at,
});

/* ---- team math channels ---- */

export function listTeamMath(sql){
  return sql`select * from math_channels order by name`;
}

/* Create or update one definition. `from` is the name it had before, for a rename:
   the row is moved rather than a second one added. The original author is kept. */
export async function saveTeamMath(sql, { name, unit, expr, from }, by){
  const old = from || name;
  const existing = (await sql`select * from math_channels where name = ${old}`)[0];
  if (existing){
    if (old !== name && (await sql`select 1 from math_channels where name = ${name}`).length)
      throw Object.assign(new Error(`the team already has a math channel called "${name}"`), { status: 409 });
    const rows = await sql`
      update math_channels set name = ${name}, unit = ${unit}, expr = ${expr},
        updated_by = ${by}, updated_at = now()
      where name = ${old} returning *`;
    return rows[0];
  }
  const rows = await sql`
    insert into math_channels (name, unit, expr, created_by, updated_by)
    values (${name}, ${unit}, ${expr}, ${by}, ${by})
    on conflict (name) do update
      set unit = excluded.unit, expr = excluded.expr, updated_by = excluded.updated_by, updated_at = now()
    returning *`;
  return rows[0];
}

export function deleteTeamMath(sql, name){
  return sql`delete from math_channels where name = ${name}`;
}

export const rowToMath = r => ({
  name: r.name, unit: r.unit, expr: r.expr,
  createdBy: r.created_by, updatedBy: r.updated_by, updatedAt: r.updated_at,
});

/* `me` is the signed-in name, used only to mark a session as this person's own -- for
   the "yours" tag and the My uploads filter. It is attribution; editing is open to
   anyone signed in. The retired owner_token never leaves the server either way. */
export function rowToDataset(r, me){
  return {
    id: r.id,
    mine: !!me && r.uploader === me,
    title: r.title,
    description: r.description,
    uploader: r.uploader,
    listed: r.listed,
    csvUrl: r.csv_url,
    csvName: r.csv_name,
    csvBytes: Number(r.csv_bytes),
    binUrl: r.bin_url,
    binBytes: Number(r.bin_bytes),
    samples: r.samples,
    channels: r.channels,
    laps: r.laps,
    durationS: r.duration_s,
    session: r.session_name,
    vehicle: r.vehicle,
    racer: r.racer,
    recordedAt: r.recorded_at,
    /* Which channel plays which role, as the uploader settled it. Names, not indices --
       see rolesToNames in viewer/session.js. */
    roles: typeof r.roles === 'string' ? JSON.parse(r.roles) : (r.roles || null),
    createdAt: r.created_at,
  };
}
