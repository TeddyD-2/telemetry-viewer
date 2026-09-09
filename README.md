# Telemetry viewer

A data viewer for AiM CSV exports that isn't painful, plus a shared library so the team can
find each other's sessions instead of mailing 80 MB files around.

Two ways in, and they are deliberately separate:

- **`/local`** — drop a CSV, work through it, nothing is uploaded. Parsing and plotting happen
  in your browser; the file never leaves your machine. This works even if nothing else is
  configured.
- **`/`** — the library. Sessions somebody chose to share, with a title, notes and who
  uploaded them. Opening one downloads a compact cached copy rather than the CSV, so a
  30-minute endurance run opens in seconds instead of a minute.

Built against `data/endurance.csv` (Michigan 2026, arg26, 30:23, 226 channels, 36 460 samples
at 20 Hz), but nothing in it is specific to that file.

## What it does

- **Laps, automatically.** No beacon channel needed — laps come from the GPS trace. 22 timed
  laps found on the Michigan run, best 1:03.15, with the 4:42 driver change correctly flagged
  as an outlier rather than counted as a lap. Click a lap to zoom to it, tick it to overlay it.
  If it picks the wrong start/finish, click anywhere on the trace in **Track** to move the line
  and everything re-times.
- **Traces.** Up to 8 channels stacked with a shared x-axis and crosshair, x in time or
  distance. Drag to zoom, wheel to zoom, shift-drag to pan, double-click to reset.
- **Compare.** The same channel over several laps, aligned on distance into the lap, plus a
  **delta-t** chart underneath showing where each lap gains or loses against a reference. This
  is the plot that answers "where did the time actually go". Both carry a legend and a
  crosshair readout of every lap's value at the cursor.

  A lap's colour belongs to the lap, not to its position in the selection: unticking one lap
  leaves the others' colours alone. (Indexing the palette by "which of the ticked laps is this"
  is the easy version and it repaints every lap after the one you removed, which quietly
  invalidates what you'd just learned.) Capped at 8 overlaid laps -- past the fixed hue order
  there is no 9th colour that stays distinguishable under colour-vision deficiency.
- **Track.** GPS map coloured by any channel, cursor linked to every other view.
- **Analysis.** g–g diagram, histogram, and min/max/mean/SD over whatever window is in view.
- **Export** the current view as PNG, or the visible window and selected channels as CSV.
- **Channel roles.** Speed, latitude, longitude, distance and the two g channels are guessed
  from names once, then shown in the sidebar and overridable from a dropdown. Nothing is
  re-guessed per view, so lap detection, the distance axis and the cursor readout always
  agree; a view whose role is unset offers the picker instead of drawing something wrong.
  Every picker lists unit and observed range next to the name, and same-named channels get a
  `#1`/`#2` suffix — a live `GPS Speed` and a dead one are never confused for each other.

### The shared library

- **Adding a session** parses the CSV in your browser first, which does two jobs: it proves the
  file really is an AiM export before 80 MB goes over the paddock wifi, and it fills in the
  title, car and driver from the session header so nobody retypes what the file already says.
- **Two files are stored per session.** The original CSV, for anyone who wants it in RS3 or
  Excel, and a compact binary of the parsed columns — 79 MB of CSV becomes 14 MB gzipped, and
  opening it is a download rather than a download *and* a reparse. `npm run check:cache`
  round-trips a real session through that format and compares every sample.
- **Shared or unlisted.** Shared sessions are listed for everyone with the site password.
  Unlisted ones are reachable by link only — useful for a rough run you want to send to one
  person, but understand that it is not a security boundary: blob URLs are unguessable, not
  access-controlled.
- **No accounts.** One password for the whole site; uploaders pick their name from the team
  roster. Your browser keeps a random token so your own unlisted sessions show up under
  *My uploads*, and so nobody else can retitle or delete the session you just added.

Small things that make it less painful than RS3: 48 of the 226 channels in this file never
change value, and they're hidden by default; channels are grouped and searchable; the lap table
shows delta-to-best inline; everything is keyboard- and wheel-driven.

## Deploying

```bash
npm install
vercel install neon      # Postgres for the session details
vercel env pull          # brings DATABASE_URL into .env.local
```

Then in the Vercel dashboard: **Storage → Create → Blob** (this sets `BLOB_READ_WRITE_TOKEN`),
and under **Settings → Environment Variables** add:

| variable | what it is |
|---|---|
| `SITE_PASSWORD` | the one password the team types to get in |
| `AUTH_SECRET` | any long random string; signs the session cookie |
| `TEAM_MEMBERS` | comma-separated roster for the uploader dropdown |

The `datasets` table is created on first use, so there is no migration step. Until the
variables are set the library page says which ones are missing rather than throwing a 500, and
`/local` keeps working throughout.

```bash
npm run dev              # http://localhost:3000
npm run check            # database queries + session-cache round trip
```

`npm run check` runs the SQL against an in-process Postgres and round-trips a real session
through the cache format, so both can be exercised without provisioning anything.

## Notes on the data

Two things worth knowing about this session, both found while building the speed fit:

- **`LateralAcc` reads about 26% high.** For a car in a corner, lateral acceleration must equal
  `v * yaw_rate` — that's kinematics, not a model. Over 26 000 cornering samples the ratio of
  the logged `LateralAcc` to `v * YawRate` has a median of **1.261**, not 1.0. That means the
  logged 2.69 g peak is really about 2.13 g. Worth chasing before anyone trusts that channel.
  Yaw rate and GPS path curvature, meanwhile, agree with each other to 1.1%, so the fault is
  specific to the accelerometer block.
- **Longitudinal acceleration here is not the car's limit.** Endurance is driven for energy, so
  the p99 of `d(GPS speed)/dt` is only 0.33 g on power against 0.85 g braking. Cornering is
  different — drivers corner at the limit even when saving energy — so the v(R) curve below
  *is* a real limit.

## `fit_speed_model.py`

Fits the corner-speed model that `sensor-fov-sandbox/speed.py` drives its car with.

```
python fit_speed_model.py data/endurance.csv
```

Path radius is measured three independent ways so they can check each other: `v / yaw_rate`
(gyro), `1 / curvature` of the GPS path (pure geometry), and `v^2 / a_lat` (accelerometer). The
last one is circular — fitting speed against a radius computed *from* speed just recovers the
accelerometer calibration — so it's reported as a cross-check and never used in the fit. The
first two are independent of each other and agree, so the radius is real.

Only timed laps count, and each radius bin is summarised by the 92nd percentile of speed rather
than the mean, because a lap's mean includes traffic, lifting and coasting; the model wants what
the car is capable of.

The result, and the reason a single-constant grip circle can't represent this car:

| radius | measured speed | implied lateral accel |
|---|---|---|
| 5 m | 8.8 m/s | 14.7 m/s² (1.50 g) |
| 15 m | 14.1 m/s | 12.1 m/s² (1.23 g) |
| 30 m | 16.7 m/s | 9.6 m/s² (0.98 g) |
| 100 m | 20.9 m/s | 4.0 m/s² (0.41 g) |

Lateral grip doesn't actually fall off a cliff — past roughly 35 m radius the car has simply run
out of **speed** rather than grip, and sits on its ~21 m/s ceiling. One `ay_max` fitted to the
tight end would have the car doing 38 m/s through a 100 m sweeper; fitted to the loose end it
would crawl through hairpins. So `speed.py` interpolates the curve instead.
