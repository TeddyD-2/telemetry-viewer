"""Fit a corner-speed model v(R) from a logged session, for sensor-fov-sandbox/speed.py.

The question being answered: on a real lap, how fast does this car actually go through a
corner of radius R? The sandbox's default answer is textbook grip-circle physics,
v = sqrt(ay_max * R) with one constant ay_max. This measures what the car really did.

Path radius is measured three independent ways so they can be checked against each other,
because each one alone is easy to fool:

  yaw    R = v / omega            gyro; clean signal, but drifts and includes yaw from slip
  gps    R = 1 / kappa(path)      pure geometry; independent of every inertial sensor
  lat    R = v^2 / a_lat          accelerometer; the definition the grip-circle model uses

`lat` is the circular one -- fitting v against a radius computed *from* v recovers only the
accelerometer calibration. It is reported as a cross-check, never used for the fit. `yaw` and
`gps` are genuinely independent of each other, so where they agree the radius is real.

Only timed laps are used: pit stops, the driver change and the in/out laps are not
representative of a driver going for a time. Each radius bin is summarised by a high
percentile of speed rather than the mean, because the mean of a lap includes traffic, lifting
and coasting -- the model wants the limit the car is capable of, not its average behaviour.

Usage:  python fit_speed_model.py data/endurance.csv
"""
import sys
import numpy as np
import pandas as pd

SMOOTH_S = 0.6      # s, smoothing window for GPS path curvature
PCTL = 92           # percentile of speed per radius bin taken as "the limit"
MIN_SAMPLES = 40    # per bin, below which the percentile is not trustworthy


def load(path):
    names = pd.read_csv(path, skiprows=14, nrows=0).columns.tolist()
    df = pd.read_csv(path, skiprows=17, header=None, names=names, low_memory=False)
    return df


def local_xy(lat, lon):
    lat0, lon0 = np.nanmean(lat), np.nanmean(lon)
    return ((lon - lon0)*111320.0*np.cos(np.radians(lat0)),
            (lat - lat0)*111132.0)


def smooth(a, w):
    if w < 3:
        return a
    k = np.ones(w)/w
    return np.convolve(np.pad(a, w, mode="edge"), k, mode="same")[w:-w]


def detect_laps(x, y, t, spd):
    """Same rule as the viewer: closest approach to a start/finish point, passes filtered to
    a single direction of travel so an out-and-back leg isn't counted twice a lap."""
    def heading(i):
        a, b = max(0, i-3), min(len(x)-1, i+3)
        return np.arctan2(y[b]-y[a], x[b]-x[a])

    def passes(ci):
        d = np.hypot(x-x[ci], y-y[ci])
        near = np.where(d < 12.0)[0]
        if len(near) == 0:
            return []
        h0 = heading(ci)
        out = []
        for grp in np.split(near, np.where(np.diff(near) > 16)[0]+1):
            b = grp[np.argmin(d[grp])]
            dh = abs((heading(b)-h0+np.pi) % (2*np.pi) - np.pi)
            if dh < np.pi/3:
                out.append(int(b))
        return out

    best = None
    for ci in range(0, len(x), max(1, len(x)//180)):
        if spd[ci] <= 8:
            continue
        cr = passes(ci)
        if len(cr) < 3:
            continue
        it = np.diff(t[cr])
        med = np.median(it[it > 5]) if (it > 5).any() else 0
        good = it[(it > med*0.75) & (it < med*1.25)]
        if len(good) < 2 or len(good)/len(it) < 0.6:
            continue
        sc = (len(good), len(good)/len(it), -good.std())
        if best is None or sc > best[0]:
            best = (sc, cr)
    if best is None:
        return [], None
    cr = best[1]
    laps = [(cr[i-1], cr[i], t[cr[i]]-t[cr[i-1]]) for i in range(1, len(cr))]
    med = np.median([l[2] for l in laps])
    timed = [l for l in laps if med*0.75 < l[2] < med*1.25]
    return timed, med


def main(path):
    df = load(path)
    t = df["Time"].to_numpy(float)
    dt = float(np.median(np.diff(t)))
    v = df["GPS Speed"].to_numpy(float)/3.6                     # m/s
    yaw = np.radians(df["YawRate"].to_numpy(float))             # rad/s
    alat = df["LateralAcc"].to_numpy(float)*9.80665             # m/s^2
    x, y = local_xy(df["GPS Latitude"].to_numpy(float), df["GPS Longitude"].to_numpy(float))

    laps, med = detect_laps(x, y, t, df["GPS Speed"].to_numpy(float))
    print(f"{len(laps)} timed laps, median {med:.2f} s "
          f"(best {min(l[2] for l in laps):.2f} s)")
    mask = np.zeros(len(t), bool)
    for i0, i1, _ in laps:
        mask[i0:i1] = True

    w = max(3, int(round(SMOOTH_S/dt)) | 1)
    xs, ys = smooth(x, w), smooth(y, w)
    xp, yp = np.gradient(xs), np.gradient(ys)
    xpp, ypp = np.gradient(xp), np.gradient(yp)
    den = (xp**2 + yp**2)**1.5
    kappa = np.divide(xp*ypp - yp*xpp, den, out=np.zeros_like(den), where=den > 1e-9)

    ys_ = smooth(yaw, w)
    with np.errstate(divide="ignore", invalid="ignore"):
        R_yaw = np.abs(v/ys_)
        R_gps = np.abs(1.0/kappa)
        R_lat = np.abs(v**2/alat)

    ok = mask & (v > 4) & np.isfinite(R_yaw) & np.isfinite(R_gps)
    ok &= (np.abs(ys_) > np.radians(4))       # near-straight: radius is unmeasurable, not large
    print(f"{ok.sum()} cornering samples of {mask.sum()} in timed laps")

    a, b = R_yaw[ok], R_gps[ok]
    sel = (a < 200) & (b < 200)
    print(f"\nradius method agreement (samples under 200 m, n={sel.sum()}):")
    print(f"  yaw vs gps : median ratio {np.median(a[sel]/b[sel]):.3f}, "
          f"corr {np.corrcoef(a[sel], b[sel])[0,1]:.3f}")
    c = R_lat[ok]
    sel2 = sel & (c < 200) & np.isfinite(c)
    print(f"  yaw vs lat : median ratio {np.median(a[sel2]/c[sel2]):.3f}  (cross-check only)")
    print(f"  identity a_lat vs v*omega: median ratio "
          f"{np.median(alat[ok]/(v[ok]*ys_[ok])):.3f}  (should be ~1 if both are calibrated)")

    R = np.sqrt(R_yaw[ok]*R_gps[ok])          # geometric mean of the two independent measures
    V = v[ok]

    edges = np.geomspace(4.0, 120.0, 19)
    print(f"\n  R range        n     v_p{PCTL}     implied a_lat")
    rows = []
    for i in range(len(edges)-1):
        m = (R >= edges[i]) & (R < edges[i+1])
        if m.sum() < MIN_SAMPLES:
            continue
        rc = float(np.sqrt(edges[i]*edges[i+1]))
        vp = float(np.percentile(V[m], PCTL))
        rows.append((rc, vp, int(m.sum())))
        print(f"{edges[i]:6.1f}-{edges[i+1]:5.1f} {m.sum():7d}   {vp:6.2f}   {vp**2/rc:6.2f} m/s^2")

    rr = np.array([r[0] for r in rows]); vv = np.array([r[1] for r in rows])
    ay = vv**2/rr
    print(f"\nimplied lateral accel: {ay.min():.2f} - {ay.max():.2f} m/s^2 "
          f"({ay.min()/9.80665:.2f} - {ay.max()/9.80665:.2f} g)")
    print(f"top speed seen: {v[mask].max():.1f} m/s ({v[mask].max()*3.6:.0f} km/h)")

    # Longitudinal limits from dv/dt, not from InlineAcc: the a_lat = v*omega check above
    # shows the accelerometer block is out of calibration, and differentiating GPS speed
    # doesn't depend on it. Smoothed first -- raw 20 Hz differences are mostly noise.
    vs = smooth(v, w)
    dv = np.gradient(vs, dt)
    good = mask & (v > 4)
    acc = float(np.percentile(dv[good & (dv > 0)], 99))
    bra = float(-np.percentile(dv[good & (dv < 0)], 1))
    print(f"\nlongitudinal from d(GPS speed)/dt, p99: "
          f"accel {acc:.2f} m/s^2 ({acc/9.80665:.2f} g), brake {bra:.2f} m/s^2 ({bra/9.80665:.2f} g)")

    # ay_max is reported from the *rounded* numbers that actually get pasted, and rounded up.
    # Rounding the radii nudges the implied lateral acceleration, and speed.py checks its
    # profile against ay_max -- a value derived from unrounded inputs shows up downstream as
    # a phantom limit violation of a tenth of a percent.
    rr_r, vv_r = np.round(rr, 1), np.round(vv, 2)
    ay_r = float((vv_r**2/rr_r).max())
    print("\n--- paste into speed.py / config.py ---")
    print("FIT_RADIUS_M = [" + ", ".join(f"{r:.1f}" for r in rr_r) + "]")
    print("FIT_SPEED_MS = [" + ", ".join(f"{s:.2f}" for s in vv_r) + "]")
    print(f"# ay_max={np.ceil(ay_r*10)/10:.1f}  ax_accel_max={acc:.1f}  "
          f"ax_brake_max={bra:.1f}  v_max={v[mask].max():.1f}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/endurance.csv")
