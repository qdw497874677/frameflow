"""Build engine stock files from digitized datasheet curves.

Usage: python3 build_stocks.py [datasheet-dir] [stock-dir]   (default: ../../data/datasheets -> ../../data/stocks)

Steps (documented in engine/PROVENANCE.md):
  * resample every curve to the engine grid (380-780 nm, 5 nm; log H step 0.05)
  * extrapolate spectral sensitivity outside the charted range with a steep
    log-linear fall-off (0.1 log units per nm) -> effectively zero
  * Portra 400 publishes only the midscale-neutral and D-min spectral density.
    The three dye spectra are recovered by fitting three two-sided Gaussians to
    (neutral - D-min); this is an assumption of the model, not datasheet data.
  * Endura dyes are charted 400-700 nm; outside that range each dye is
    extended with a two-sided Gaussian fitted to its charted part.
Only numpy is required.
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "data"))
WL = np.arange(380.0, 780.0 + 1e-9, 5.0)
LOGH_STEP = 0.05
FALLOFF = 0.1  # log10 units per nm beyond the charted sensitivity


def curve(points):
    p = np.array(points, dtype=float)
    _, idx = np.unique(p[:, 0], return_index=True)
    return p[idx]


def resample_sensitivity(points):
    p = curve(points)
    x0, x1 = p[0, 0], p[-1, 0]
    v = np.interp(WL, p[:, 0], p[:, 1])
    v = np.where(WL < x0, p[0, 1] - FALLOFF * (x0 - WL), v)
    v = np.where(WL > x1, p[-1, 1] - FALLOFF * (WL - x1), v)
    return v


def resample_density_curve(points, lo, hi):
    p = curve(points)
    grid = np.round(np.arange(lo, hi + 1e-9, LOGH_STEP), 4)
    return grid, np.interp(grid, p[:, 0], p[:, 1])


def gauss2(x, mu, sl, sr):
    s = np.where(x < mu, sl, sr)
    return np.exp(-0.5 * ((x - mu) / s) ** 2)


def model(params, x):
    out = np.zeros_like(x)
    for a, mu, sl, sr in params.reshape(-1, 4):
        out += a * gauss2(x, mu, sl, sr)
    return out


def fit(x, y, p0, lo, hi, iters=300):
    """Levenberg-Marquardt with box constraints (projected)."""
    p, lam = np.array(p0, float), 1e-2
    def res(q):
        return model(q, x) - y
    r = res(p)
    for _ in range(iters):
        J = np.empty((x.size, p.size))
        for i in range(p.size):
            d = np.zeros_like(p); d[i] = 1e-4 * max(1.0, abs(p[i]))
            J[:, i] = (res(p + d) - r) / d[i]
        A = J.T @ J
        step = np.linalg.solve(A + lam * np.diag(np.diag(A) + 1e-12), -J.T @ r)
        q = np.clip(p + step, lo, hi)
        rq = res(q)
        if rq @ rq < r @ r:
            p, r, lam = q, rq, lam * 0.3
        else:
            lam *= 10
        if lam > 1e8:
            break
    return p, float(np.sqrt(np.mean(r ** 2)))


def portra_dyes(dd):
    neutral, dmin = curve(dd["midscale_neutral"]), curve(dd["dmin"])
    x = np.arange(400.0, 700.0 + 1e-9, 2.0)
    y = np.interp(x, neutral[:, 0], neutral[:, 1]) - np.interp(x, dmin[:, 0], dmin[:, 1])
    #            amp  mu   sl  sr     (yellow, magenta, cyan)
    p0 = [1.0, 445, 25, 25, 1.0, 545, 30, 30, 1.0, 690, 50, 40]
    lo = [0.1, 425, 10, 10, 0.1, 525, 10, 10, 0.1, 650, 20, 20]
    hi = [3.0, 465, 60, 60, 3.0, 565, 60, 60, 3.0, 720, 90, 90]
    p, rms = fit(x, y, p0, lo, hi)
    dyes = {k: gauss2(WL, *p.reshape(-1, 4)[i, 1:]) for i, k in enumerate(("y", "m", "c"))}
    dmin_wl = np.interp(WL, dmin[:, 0], dmin[:, 1])  # held constant beyond 400/700
    fitinfo = {"params": [[round(v, 3) for v in row] for row in p.reshape(-1, 4).tolist()], "rms": round(rms, 4)}
    return dyes, dmin_wl, fitinfo


def endura_dyes(dd):
    dyes, info = {}, {}
    for key, name, mu in (("y", "yellow", 445), ("m", "magenta", 545), ("c", "cyan", 660)):
        c = curve(dd[name])
        inside = np.interp(WL, c[:, 0], c[:, 1])
        p, rms = fit(c[:, 0], c[:, 1], [1.0, mu, 30, 30], [0.5, mu - 40, 5, 5], [1.5, mu + 40, 120, 120])
        ext = model(p, WL)
        v = np.where((WL < c[0, 0]) | (WL > c[-1, 0]), ext, inside)
        dyes[key] = np.maximum(v, 0.0)
        info[name] = {"params": [round(t, 3) for t in p.tolist()], "rms": round(rms, 4)}
    return dyes, info


def arr(v, nd=4):
    return [round(float(t), nd) for t in v]


def build_portra(src):
    ch = src["charts"]
    sens = {k: arr(resample_sensitivity(ch["sensitivity"]["curves"][n]), 3) for k, n in (("b", "yellow"), ("g", "magenta"), ("r", "cyan"))}
    dyes, dmin, fitinfo = portra_dyes(ch["dye_density"]["curves"])
    cc = ch["characteristic"]["curves"]
    lo = max(curve(cc[c])[0, 0] for c in cc); hi = min(curve(cc[c])[-1, 0] for c in cc)
    lo, hi = np.ceil(lo / LOGH_STEP) * LOGH_STEP, np.floor(hi / LOGH_STEP) * LOGH_STEP
    grid, _ = resample_density_curve(cc["red"], lo, hi)
    return {
        "id": "portrait400", "name": "Portrait 400", "inspiredBy": "Kodak Portra 400 (datasheet E-4050)",
        "kind": "negative",
        "source": {"datasheet": "kodak-portra-400.json", "sha256": src["sha256"], "url": src["url"]},
        "wavelengths": {"start": 380, "step": 5, "count": int(WL.size)},
        "logSensitivity": sens,
        "dyeDensity": {k: arr(v) for k, v in dyes.items()},
        "dmin": arr(dmin),
        "densitometry": "status-m",
        "densityCurves": {"logH": arr(grid, 3), **{k: arr(resample_density_curve(cc[n], lo, hi)[1]) for k, n in (("b", "blue"), ("g", "green"), ("r", "red"))}},
        "logHRef": -1.44,
        "fit": {"dyeDecomposition": fitinfo},
    }


def build_endura(src):
    ch = src["charts"]
    sens = {k: arr(resample_sensitivity(ch["sensitivity"]["curves"][n]), 3) for k, n in (("b", "yellow"), ("g", "magenta"), ("r", "cyan"))}
    dyes, info = endura_dyes(ch["dye_density"]["curves"])
    cc = ch["characteristic"]["curves"]
    lo = max(curve(cc[c])[0, 0] for c in cc); hi = min(curve(cc[c])[-1, 0] for c in cc)
    lo, hi = np.ceil(lo / LOGH_STEP) * LOGH_STEP, np.floor(hi / LOGH_STEP) * LOGH_STEP
    grid, _ = resample_density_curve(cc["red"], lo, hi)
    return {
        "id": "premierpaper", "name": "Premier Paper", "inspiredBy": "Kodak Endura Premier (datasheet E-4070)",
        "kind": "paper",
        "source": {"datasheet": "kodak-endura-premier.json", "sha256": src["sha256"], "url": src["url"]},
        "wavelengths": {"start": 380, "step": 5, "count": int(WL.size)},
        "logSensitivity": sens,
        "dyeDensity": {k: arr(v) for k, v in dyes.items()},
        "dmin": arr(np.zeros_like(WL)),
        "densitometry": "status-a",
        "densityCurves": {"logH": arr(grid, 3), **{k: arr(resample_density_curve(cc[n], lo, hi)[1]) for k, n in (("b", "blue"), ("g", "green"), ("r", "red"))}},
        "fit": {"dyeExtrapolation": info},
    }


def main():
    ds = sys.argv[1] if len(sys.argv) > 1 else os.path.join(DATA, "datasheets")
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(DATA, "stocks")
    os.makedirs(out, exist_ok=True)
    for build, name in ((build_portra, "kodak-portra-400.json"), (build_endura, "kodak-endura-premier.json")):
        stock = build(json.load(open(os.path.join(ds, name))))
        with open(os.path.join(out, stock["id"] + ".json"), "w") as f:
            json.dump(stock, f, separators=(",", ":"))
            f.write("\n")
        print(stock["id"], json.dumps(stock["fit"]))


if __name__ == "__main__":
    main()
