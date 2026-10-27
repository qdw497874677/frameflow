"""Digitize vector curves from manufacturer datasheet PDFs.

Usage: python3 digitize.py <pdf-dir> <out-dir>

For each chart in spec.json the page is converted to SVG with poppler's
pdftocairo, the referenced <path> elements are flattened to polylines and
mapped from PDF points to chart units by the two-point axis calibration in
spec.json (read off the chart's tick marks). Output: one JSON per document
with raw points (no smoothing or resampling) plus the sha256 of the PDF.
"""
import hashlib, json, os, subprocess, sys, tempfile
from svgpaths import paths

HERE = os.path.dirname(os.path.abspath(__file__))

def axis(cal):
    (p0, p1), (v0, v1) = cal["pt"], cal["value"]
    return lambda p: v0 + (p - p0) * (v1 - v0) / (p1 - p0)

def page_svg(pdf, page, tmp):
    out = os.path.join(tmp, f"p{page}.svg")
    if not os.path.exists(out):
        subprocess.run(["pdftocairo", "-svg", "-f", str(page), "-l", str(page), pdf, out], check=True)
    return out

def digitize(doc, pdf_dir, tmp):
    pdf = os.path.join(pdf_dir, doc["pdf"])
    sha = hashlib.sha256(open(pdf, "rb").read()).hexdigest()
    charts = {}
    for name, ch in doc["charts"].items():
        svg = paths(page_svg(pdf, ch.get("page", doc.get("page")), tmp))
        fx, fy = axis(ch["x"]), axis(ch["y"])
        curves = {}
        for cname, idx in ch["curves"].items():
            pts = [(round(fx(x), 3), round(fy(y), 4)) for sub in svg[idx]["subs"] for x, y in sub]
            pts.sort()
            curves[cname] = pts
        charts[name] = {"x": ch["x"]["quantity"], "y": ch["y"]["quantity"], "notes": ch.get("notes", ""), "curves": curves}
    return {"document": doc["document"], "url": doc["url"], "sha256": sha, "charts": charts}

def main():
    pdf_dir, out_dir = sys.argv[1], sys.argv[2]
    spec = json.load(open(os.path.join(HERE, "spec.json")))
    os.makedirs(out_dir, exist_ok=True)
    for key, doc in spec.items():
        with tempfile.TemporaryDirectory() as tmp:
            data = digitize(doc, pdf_dir, tmp)
        with open(os.path.join(out_dir, key + ".json"), "w") as f:
            json.dump(data, f, indent=1)
        print(key, data["sha256"], {c: {k: len(v) for k, v in ch["curves"].items()} for c, ch in data["charts"].items()})

if __name__ == "__main__":
    main()
