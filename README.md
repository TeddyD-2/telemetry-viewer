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
  as an outlier rather than counted as a lap. It is not tuned to that track: `npm run
  check:laps` runs it over skidpad-length laps (4.3 s) through to a long circuit (90 s), from
  2 laps to 40, at 5–50 Hz, plus a figure-eight that crosses itself. Click a lap to zoom to it, tick it to overlay it.
  If it picks the wrong start/finish, click anywhere on the trace in **Track** to move the line
  and everything re-times.
- **Two views.** **Charts** is the plotting workspace (what used to be Traces, with Analysis
  folded in). **Lap analysis** is the track map beside the lap comparison, with the lap and
  sector table underneath (what used to be Track and Compare).
- **Charts.** Up to 24 channels across any number of charts, two-up by default (rows, two or
  three columns under Layout), drawn with [uPlot](https://github.com/leeoniya/uPlot) —
  canvas, ~45 KB, built for long ordered series. Drag to zoom, wheel to zoom about the
  pointer, double-click to reset; the cursor is synchronised across every chart. Drag a
  chart's bottom edge to size that chart alone.

  **+ Chart** adds a chart of any kind, and each chart's settings button changes it:
  - *Line* — x axis (time, distance, or follow the toolbar), style (line, step, points,
    area), y scale (auto, from zero, fixed range, logarithmic; wheel over the y axis zooms
    it), merged channels on their own scales with an axis each side or on one shared scale,
    reference lines, lap start lines, min/avg/max of the zoom window in the header.
  - *XY scatter* — any channel against any other, coloured by a third, over the zoom window
    or the whole session, with a linear, quadratic or cubic trend line and its R². Box-zoom.
    Equal aspect and g rings make it the g–g diagram, which **+ Chart** also offers directly.
  - *Histogram* — bins, % of samples / seconds / count, cumulative; mean and p5/p95 marked.
  - *Spectrum* — amplitude by Welch's method (Hann, 50% overlap), segment length and log
    axes selectable. What a damper's body mode looks like.
  - *Statistics* — min, max, mean, median, SD, RMS, p5, p95, time integral per channel, or
    the same broken down per lap.

  Each chart exports its own PNG or CSV. **M** (or the Marker button) drops a marker at the
  cursor; every readout then shows its difference from it, and the header shows Δt and Δd.
- **Comparing sessions.** **+ Add session to compare** in the Sessions panel opens another
  session alongside this one — from the team library, or a CSV on this computer (parsed
  locally, not uploaded). Every chart overlays the same channel from it, lighter and dashed;
  math channels are evaluated on it too. Its laps join the Laps panel and can be ticked in
  Lap analysis next to today's, with delta-t between them. **shift** slides it along the x
  axis and **align best laps** lines the two best laps up.

  Laps from the imported session are timed from *this* session's start/finish line, and
  every lap boundary is interpolated to where the car actually crossed that line rather
  than taken at the nearest sample. Without that a 20 Hz logger puts the two sessions' lap
  starts up to 1.5 m apart, which is a quarter of a second of delta-t through a slow corner
  that is not really there. `npm run check:analysis` imports the Michigan run against a
  copy of itself with nine minutes cut off and checks delta-t stays at zero.

  **Arrange by dragging a chart's header.** Release on the middle of another chart to
  overlay the two — how brake pressure goes under speed; merged channels keep independent
  vertical scales, because bar and km/h have no shared axis. Release near an edge, where a
  red marker shows, to move it there. In a merged chart, dragging one channel's name pulls
  just that channel out. Sidebar rows drag straight onto the stack the same way. Escape, or
  releasing anywhere else, puts it back.

  Charts are keyed by the channels they hold, so a change keeps every chart it did not touch:
  heights and the scroll position survive, and the rest slide to their new places rather than
  the whole stack being rebuilt.
- **Math channels.** A new channel written as an expression over the others, as in RS3:
  `"GPS Speed" / 3.6`, `smooth(deriv("GPS Speed" / 3.6), 0.25) / g`,
  `("Speed1" - "Speed2") / max("Speed1", 1) * 100`. **+ ƒ Math** in any channel panel opens
  the editor, which completes channel names, points at the exact characters of any error,
  and previews the result over the whole session before it is saved. Operators
  `+ - * / % ^`, comparisons and `&& || !` (giving 1/0), `cond ? a : b`; functions
  `abs sqrt pow exp ln log10 min max clamp hypot round floor ceil sign`, trig, `if`, `isnan`,
  and the ones that need a whole column — `deriv` (per second), `integ`, `smooth(x, s)`,
  `delay(x, s)`. Constants `pi e g`, and `time` and `dist`.

  A math channel is a channel like any other: plot it, colour the map by it, histogram it,
  export it, use it in another math channel. Definitions are kept in the browser and applied
  to every session opened, since "wheel slip" is written once per car, not once per file; one
  whose inputs a file lacks stays listed with its error. They are not uploaded with a session
  or shared with the team. `npm run check:math` tests the expression language, including
  against the real file.

  The XY scatter draws its own points onto a uPlot frame, since a point cloud is not an
  ordered series; the track map stays hand-rolled canvas.
- **Lap analysis.** The GPS map, coloured by any channel, beside the ticked laps' channels
  aligned on distance into the lap and a **delta-t** chart showing where each lap gains or
  loses against the reference. This is the view that answers "where did the time actually
  go", and the two halves are linked: hovering a chart puts a dot on the map for every lap at
  that distance, and hovering the map moves the charts. Click the map to move the
  start/finish line. Underneath, a table of the ticked laps: time, Δ to the reference,
  sector times (2–6 equal fractions of each lap's distance, best in each column marked),
  speed range, the compared channels' averages, and an *Ideal* lap per session built from
  its best sectors. Click a row to make it the reference.

  A lap's colour belongs to the lap, not to its position in the selection: unticking one lap
  leaves the others' colours alone. (Indexing the palette by "which of the ticked laps is this"
  is the easy version and it repaints every lap after the one you removed, which quietly
  invalidates what you'd just learned.) Capped at 8 overlaid laps -- past the fixed hue order
  there is no 9th colour that stays distinguishable under colour-vision deficiency.
- **Export** the current view as PNG (laid out as on screen), the visible window and plotted
  channels as CSV, or any single chart's PNG/CSV from its settings.
- **A sidebar that follows the view.** Every panel collapses, and each view opens only the
  ones it is about: Charts is sessions and a channel picker, Lap analysis is sessions, laps
  and the channels to compare. Charts starts with nothing plotted — no five channels are
  right for everyone, and picking some just means clearing them.
- **Channel roles.** Speed, latitude, longitude, distance and the two g channels are matched
  by name once. Nothing is re-guessed per view, so lap detection, the distance axis and the
  cursor readout always agree. The panel stays collapsed while the matching holds — on a
  clean export there is nothing to do in it — and opens itself when a role is unset or
  ambiguous.

  **Conflicts are settled once, at import.** The upload page runs the same matching the
  viewer does, asks about anything it cannot settle, and stores the answers with the
  session, so nobody who opens it later is asked again. That is why the role logic lives in
  `lib/viewer/session.js` rather than inside the viewer — the upload page has no canvas to
  hang it off. Lap counts are computed there too, so a library card is right the moment it
  appears.

  **Where two channels match equally well, the viewer does not choose.** One Michigan export
  carries two live channels both called `GPS Speed`, one peaking at 79 km/h and one at 284.
  Any tie-break — widest range, first column, closest to the GPS track — is the viewer
  quietly deciding which of the team's channels is real, and every lap time hangs off that.
  So the role resolves to nothing and asks. Every picker lists unit and observed range next
  to the name, and same-named channels get a `#1`/`#2` suffix, which is usually all it takes
  to tell them apart.

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
- **No accounts, but names.** One password for the whole site, then you pick who you are
  from the roster. Uploads are credited to whoever is signed in, and your own unlisted
  sessions follow you to any browser.

  **Anyone signed in can edit or delete anything.** Everyone past the password is already a
  teammate who can read every session and upload more; making them track down whoever
  pressed the button first to fix a typo'd title buys nothing. The uploader is recorded and
  shown, but that is attribution, not permission — and it survives someone else editing the
  session. Deleting still asks, and names whose run it is when it is not yours.

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
| `TEAM_MEMBERS` | comma-separated roster; the list you pick your name from at sign-in |

The `datasets` table is created on first use, so there is no migration step. Until the
variables are set the library page says which ones are missing rather than throwing a 500, and
`/local` keeps working throughout.

```bash
npm run dev              # http://localhost:3000
npm run check            # everything below
npm run check:db         # the library's SQL, against an in-process Postgres
npm run check:laps       # lap detection, on real and synthetic sessions
npm run check:cache      # session cache round trip, sample by sample
```

None of these need a database, a blob store or a network — the SQL runs against Postgres
compiled to WASM, and the lap and cache checks run against `data/endurance.csv` plus
generated tracks. They cover the three places where being wrong is silent rather than loud.

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
