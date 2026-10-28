#!/usr/bin/env python3
"""Minimal client for the frameflow-film framed protocol (development/verification only).

Usage:
  ffe_client.py --engine build/frameflow-film --data data/stocks hello
  ffe_client.py ... render IN.jpg OUT.png [--stock portrait400] [--ev 0] [--max 2048] [--compare OUT_SIDE.jpg]
"""
import argparse
import json
import struct
import subprocess
import sys
import time

import numpy as np
from PIL import Image, ImageDraw


class Engine:
    def __init__(self, binary, data):
        self.proc = subprocess.Popen([binary, "--data", data], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.next_id = 1

    def call(self, header, payload=b""):
        header = dict(header, id=self.next_id)
        self.next_id += 1
        h = json.dumps(header).encode()
        self.proc.stdin.write(b"FFE1" + struct.pack("<I", len(h)) + h + struct.pack("<I", len(payload)) + payload)
        self.proc.stdin.flush()
        out = self.proc.stdout
        if out.read(4) != b"FFE1":
            raise RuntimeError("bad magic from engine")
        (hl,) = struct.unpack("<I", out.read(4))
        resp = json.loads(out.read(hl))
        (pl,) = struct.unpack("<I", out.read(4))
        data = out.read(pl)
        if not resp.get("ok"):
            raise RuntimeError(resp.get("error"))
        return resp, data

    def close(self):
        try:
            self.call({"op": "shutdown"})
        finally:
            self.proc.stdin.close()
            self.proc.wait(5)


def apply_lut(img, lut, n):
    """Trilinear lookup, lut shaped [b][g][r][3] in encoded sRGB."""
    x = img.astype(np.float32) / 255.0 * (n - 1)
    i0 = np.clip(np.floor(x).astype(int), 0, n - 2)
    f = x - i0
    out = np.zeros_like(x)
    for db in (0, 1):
        for dg in (0, 1):
            for dr in (0, 1):
                w = (f[..., 0] if dr else 1 - f[..., 0]) * (f[..., 1] if dg else 1 - f[..., 1]) * (f[..., 2] if db else 1 - f[..., 2])
                out += w[..., None] * lut[i0[..., 2] + db, i0[..., 1] + dg, i0[..., 0] + dr]
    return np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True)
    ap.add_argument("--data", required=True)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hello")
    r = sub.add_parser("render")
    r.add_argument("input")
    r.add_argument("output")
    r.add_argument("--stock", default="portrait400")
    r.add_argument("--ev", type=float, default=0.0)
    r.add_argument("--max", type=int, default=2048)
    r.add_argument("--compare")
    r.add_argument("--param", action="append", default=[], metavar="KEY=VALUE",
                   help="extra render param, e.g. --param grain=1 (spatial params are not baked into the LUT)")
    args = ap.parse_args()

    eng = Engine(args.engine, args.data)
    try:
        if args.cmd == "hello":
            print(json.dumps(eng.call({"op": "hello"})[0]))
            print(json.dumps(eng.call({"op": "list_stocks"})[0]))
            return
        img = Image.open(args.input).convert("RGB")
        img.thumbnail((args.max, args.max))
        src = np.asarray(img)
        params = {"exposureEv": args.ev}
        extra = {k: float(v) for k, v in (kv.split("=", 1) for kv in args.param)}
        t = time.time()
        resp, data = eng.call({"op": "render", "stock": args.stock, "width": img.width, "height": img.height,
                               "format": "rgb8", "params": {**params, **extra}}, src.tobytes())
        wall = (time.time() - t) * 1000
        film = np.frombuffer(data, np.uint8).reshape(src.shape)
        Image.fromarray(film).save(args.output, quality=92)
        bake, lut_bytes = eng.call({"op": "bake_lut", "stock": args.stock, "size": 33, "params": params})
        lut = np.frombuffer(lut_bytes, np.float32).reshape(33, 33, 33, 3)
        via_lut = apply_lut(src, lut, 33)
        diff = np.abs(via_lut.astype(int) - film.astype(int))
        print(json.dumps({"input": args.input, "size": [img.width, img.height], "render_ms": round(resp["ms"], 1),
                          "wall_ms": round(wall, 1), "bake33_ms": round(bake["ms"], 1),
                          "lut_vs_render_mean": round(float(diff.mean()), 3), "lut_vs_render_p99": int(np.percentile(diff, 99))}))
        if args.compare:
            w, h = img.width, img.height
            side = Image.new("RGB", (w * 2 + 20, h + 60), "white")
            side.paste(img, (0, 60))
            side.paste(Image.fromarray(film), (w + 20, 60))
            d = ImageDraw.Draw(side)
            d.text((10, 20), "original (sRGB)", fill="black")
            d.text((w + 30, 20), f"FrameFlow film engine: {args.stock} -> premierpaper, EV {args.ev:+g}", fill="black")
            side.thumbnail((3000, 3000))
            side.save(args.compare, quality=90)
    finally:
        eng.close()


if __name__ == "__main__":
    sys.exit(main())
