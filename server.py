#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "pillow"]
# ///
"""Plantenna local server.

Serves the web app and turns the open geodata of Schleswig-Holstein (LVermGeo SH,
CC BY 4.0) into tiles the browser can use:

  /tiles/dop/{z}/{x}/{y}.png  DOP20 orthophotos (proxied WMS, the service sends no CORS headers)
  /tiles/dem/{z}/{x}/{y}.png  terrain (DGM1 / DGM5) as Terrarium-encoded elevation tiles
  /tiles/dom/{z}/{x}/{y}.png  surface incl. buildings and vegetation (bDOM), Terrarium-encoded
  /tiles/view-dem/…, /tiles/view-dom/…  terrain for the 3D map display: like dem/dom, but
      only from data that is already cached (never downloads), global terrain elsewhere

Elevation source data comes as 1 km x 1 km tiles in ETRS89 / UTM 32N. They are
downloaded on first use and cached under ./cache. Outside Schleswig-Holstein (and
over the sea) the AWS Terrain Tiles are used instead.

Run:  uv run server.py   (or: pip install numpy pillow && python3 server.py)
"""

import argparse
import io
import json
import math
import re
import ssl
import sys
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "cache"

SH_PORTAL = "https://geodaten.schleswig-holstein.de/gaialight-sh/_apps/dladownload"
DOP_WMS = (
    "https://service.gdi-sh.de/WMS_SH_DOP20col_OpenGBD?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap"
    "&LAYERS=sh_dop20_rgb&STYLES=&CRS=EPSG:3857&FORMAT=image/png&TRANSPARENT=TRUE"
    "&WIDTH=512&HEIGHT=512&BBOX={bbox}"
)
AWS_TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
# geodaten.schleswig-holstein.de does not send its intermediate certificate. We fetch it
# from the issuer's AIA location and add it so that the chain to the system root verifies.
SH_INTERMEDIATE_CERT = "http://www.d-trust.net/cgi-bin/D-TRUST_BR_CA_1-20-1_2020.crt"
SH_ROOT_CERT = "http://www.d-trust.net/cgi-bin/D-TRUST_BR_Root_CA_1_2020.crt"

PRODUCTS = {
    "dgm1": {"index": "DGM1_SH__Massendownload.geojson", "res": 1.0},
    "dgm5": {"index": "DGM5_SH__Massendownload.geojson", "res": 5.0},
    "bdom": {"index": "bDOM_SH_Massendownload.geojson", "res": 1.0},  # 20 cm source, max-pooled to 1 m
}

NODATA = -32768  # cached km tiles are int16 centimetres
TILE = 256
USER_AGENT = "plantenna/0.1 (LoRa antenna planning tool)"

# ---------------------------------------------------------------------------
# HTTP


def make_ssl_context():
    ctx = ssl.create_default_context()
    # The download server omits the D-Trust chain.  The intermediate alone is
    # not sufficient on machines whose system trust store does not contain the
    # D-Trust root, so add both certificates to the normal system context.
    certs = {
        CACHE / "d-trust-intermediate.pem": SH_INTERMEDIATE_CERT,
        CACHE / "d-trust-root.pem": SH_ROOT_CERT,
    }
    for pem_path, url in certs.items():
        if not pem_path.exists():
            der = urllib.request.urlopen(url, timeout=30).read()
            pem_path.parent.mkdir(parents=True, exist_ok=True)
            pem_path.write_text(ssl.DER_cert_to_PEM_cert(der))
        ctx.load_verify_locations(cafile=str(pem_path))
    return ctx


SSL_CTX = None
download_slots = threading.Semaphore(4)


def http_get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with download_slots, urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as res:
        return res.read()


# ---------------------------------------------------------------------------
# Coordinates


def tile_pixel_lonlat(z, x, y, oversample=1):
    """Lon/lat of the sample points of a Web Mercator tile, shape (TILE*k, TILE*k)."""
    n = TILE * oversample
    world = TILE * 2**z
    offs = (np.arange(n) + 0.5) / oversample
    px = x * TILE + offs
    py = y * TILE + offs
    lon = px / world * 360 - 180
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * py / world))))
    return np.meshgrid(lon, lat)


def lonlat_to_utm32(lon, lat):
    """ETRS89 (GRS80) lon/lat in degrees -> UTM zone 32N easting/northing in metres."""
    a = 6378137.0
    f = 1 / 298.257222101
    k0 = 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    phi = np.radians(lat)
    lam = np.radians(lon - 9.0)
    sin, cos, tan = np.sin(phi), np.cos(phi), np.tan(phi)
    N = a / np.sqrt(1 - e2 * sin**2)
    T = tan**2
    C = ep2 * cos**2
    A = lam * cos
    e4, e6 = e2**2, e2**3
    M = a * (
        (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
        - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * np.sin(2 * phi)
        + (15 * e4 / 256 + 45 * e6 / 1024) * np.sin(4 * phi)
        - (35 * e6 / 3072) * np.sin(6 * phi)
    )
    east = 500000 + k0 * N * (
        A + (1 - T + C) * A**3 / 6 + (5 - 18 * T + T**2 + 72 * C - 58 * ep2) * A**5 / 120
    )
    north = k0 * (
        M
        + N * tan * (
            A**2 / 2
            + (5 - T + 9 * C + 4 * C**2) * A**4 / 24
            + (61 - 58 * T + T**2 + 600 * C - 330 * ep2) * A**6 / 720
        )
    )
    return east, north


def tile_bbox_3857(z, x, y):
    size = 2 * math.pi * 6378137 / 2**z
    origin = math.pi * 6378137
    return (x * size - origin, origin - (y + 1) * size, (x + 1) * size - origin, origin - y * size)


# ---------------------------------------------------------------------------
# Schleswig-Holstein elevation data (1 km tiles)

index_lock = threading.Lock()
indexes = {}


def product_index(product):
    """{(east_km, north_km): download url} for a product, cached on disk."""
    with index_lock:
        if product in indexes:
            return indexes[product]
        path = CACHE / "index" / f"{product}.json"
        if path.exists():
            entries = json.loads(path.read_text())
        else:
            name = PRODUCTS[product]["index"]
            print(f"Downloading tile index for {product} …", file=sys.stderr)
            text = http_get(f"{SH_PORTAL}/single.php?file={name}&id=4").decode("utf-8")
            entries = {}
            for url in re.findall(r'"link_data":\s*"([^"]+)"', text):
                m = re.search(r"_32_(\d+)_(\d+)_1_sh_(\d{4})", url)
                if not m:
                    continue
                key = f"{m[1]}_{m[2]}"
                # Keep the most recent survey if a tile is listed more than once.
                if key not in entries or entries[key][1] < m[3]:
                    entries[key] = (url, m[3])
            entries = {k: v[0] for k, v in entries.items()}
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(entries))
        indexes[product] = entries
        return entries


km_locks = {}
km_locks_guard = threading.Lock()
km_memory = {}  # small in-memory LRU of decoded km tiles
KM_MEMORY_MAX = 64


def km_tile(product, e, n, download=True):
    """int16 centimetre grid of one 1 km tile (row 0 = north), or None if not covered
    (or, with download=False, not cached yet)."""
    key = (product, e, n)
    if key in km_memory:
        return km_memory[key]
    if not download and not (CACHE / product / f"{e}_{n}.npy").exists():
        return None
    with km_locks_guard:
        lock = km_locks.setdefault(key, threading.Lock())
    with lock:
        if key in km_memory:
            return km_memory[key]
        grid = load_km_tile(product, e, n)
        if len(km_memory) >= KM_MEMORY_MAX:
            km_memory.pop(next(iter(km_memory)))
        km_memory[key] = grid
        return grid


def load_km_tile(product, e, n):
    path = CACHE / product / f"{e}_{n}.npy"
    if path.exists():
        return np.load(path)
    url = product_index(product).get(f"{e}_{n}")
    if url is None:
        return None
    print(f"Downloading {product} tile {e}_{n} …", file=sys.stderr)
    raw = http_get(url, timeout=600)
    res = PRODUCTS[product]["res"]
    if product == "bdom":
        grid = parse_bdom(raw, e, n)
    else:
        grid = parse_xyz(raw, e, n, res)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, grid)
    return grid


def parse_xyz(raw, e, n, res):
    size = int(round(1000 / res))
    vals = np.array(raw.replace(b"\xef\xbb\xbf", b"").split(), dtype=np.float64).reshape(-1, 3)
    col = np.floor((vals[:, 0] - e * 1000) / res).astype(np.int64)
    row = np.floor((n * 1000 + 1000 - vals[:, 1]) / res).astype(np.int64)
    ok = (col >= 0) & (col < size) & (row >= 0) & (row < size)
    grid = np.full((size, size), NODATA, np.int16)
    grid[row[ok], col[ok]] = np.round(vals[ok, 2] * 100)
    return grid


def parse_bdom(raw, e, n):
    img = Image.open(io.BytesIO(raw))
    arr = np.asarray(img, dtype=np.float32)
    tie = img.tag_v2.get(33922)  # GeoTIFF ModelTiepoint: (i, j, k, x, y, z)
    if tie and (abs(tie[3] - e * 1000) > 0.5 or abs(tie[4] - (n + 1) * 1000) > 0.5):
        print(f"warning: bDOM tile {e}_{n} has unexpected origin {tie[3:5]}", file=sys.stderr)
    f = arr.shape[0] // 1000
    arr = np.where(np.isnan(arr), -np.inf, arr)[: 1000 * f, : 1000 * f]
    # Max-pool to 1 m: an obstacle anywhere in the cell blocks the cell.
    pooled = arr.reshape(1000, f, 1000, f).max(axis=(1, 3))
    grid = np.full((1000, 1000), NODATA, np.int16)
    ok = np.isfinite(pooled)
    grid[ok] = np.round(pooled[ok] * 100)
    return grid


def sample_product(product, east, north, out, download=True, cell=None):
    """Fill NaNs in `out` with samples from the product's km tiles (nearest neighbour).

    With `cell` (metres), sample the block-mean level of that cell size instead of
    the full-resolution grid (cached tiles only, see km_level).
    """
    native = PRODUCTS[product]["res"]
    if cell is None or cell <= native:
        res = native
        load = lambda k: km_tile(product, *k, download)  # noqa: E731
    else:
        res = cell
        load = lambda k: km_level(product, *k, cell)  # noqa: E731
    size = int(round(1000 / res))

    todo = np.flatnonzero(np.isnan(out))
    e_todo, n_todo = east.ravel()[todo], north.ravel()[todo]
    ek = np.floor(e_todo / 1000).astype(np.int64)
    nk = np.floor(n_todo / 1000).astype(np.int64)
    keys, inverse = np.unique(np.stack([ek, nk], axis=1), axis=0, return_inverse=True)
    inverse = inverse.ravel()
    order = np.argsort(inverse, kind="stable")
    bounds = np.searchsorted(inverse[order], np.arange(len(keys) + 1))
    grids = list(POOL.map(load, [tuple(k) for k in keys.tolist()]))
    flat = out.reshape(-1)
    for i, ((e, n), grid) in enumerate(zip(keys.tolist(), grids)):
        if grid is None:
            continue
        sel = order[bounds[i] : bounds[i + 1]]
        col = np.clip(((e_todo[sel] - e * 1000) / res).astype(np.int64), 0, size - 1)
        row = np.clip(((n * 1000 + 1000 - n_todo[sel]) / res).astype(np.int64), 0, size - 1)
        v = grid[row, col]
        flat[todo[sel]] = np.where(v == NODATA, np.nan, v / 100.0)


level_memory = {}
LEVEL_MEMORY_MAX = {5: 1000, 25: 20000}  # 80 kB / 3 kB per entry


def km_level(product, e, n, cell):
    """Block mean of a *cached* km tile at `cell` metres, or None if not cached.

    Used for the zoomed-out 3D display, so it reads no full-resolution grids once a
    level exists. Levels are stored next to the km tile in the cache.
    """
    key = (product, e, n, cell)
    if key in level_memory:
        return level_memory[key]
    path = CACHE / product / f"{e}_{n}_{cell}m.npy"
    if path.exists():
        grid = np.load(path)
    else:
        full = km_tile(product, e, n, download=False)
        if full is None:
            return None  # not memoized: an analysis may download it later
        f = int(round(cell / PRODUCTS[product]["res"]))
        size = full.shape[0] // f
        blocks = full.reshape(size, f, size, f)
        valid = blocks != NODATA
        count = valid.sum(axis=(1, 3))
        total = np.where(valid, blocks, 0).sum(axis=(1, 3), dtype=np.int64)
        grid = np.full((size, size), NODATA, np.int16)
        grid[count > 0] = np.round(total[count > 0] / count[count > 0])
        tmp = path.with_suffix(".tmp.npy")
        np.save(tmp, grid)
        tmp.replace(path)
    same_cell = [k for k in level_memory if k[3] == cell]
    if len(same_cell) >= LEVEL_MEMORY_MAX[cell]:
        level_memory.pop(same_cell[0], None)
    level_memory[key] = grid
    return grid


POOL = ThreadPoolExecutor(8)


# ---------------------------------------------------------------------------
# Terrarium tiles


def aws_elevation(z, x, y):
    """256x256 elevation from the global AWS terrain tiles (sea clamped to 0 m)."""
    shift = max(0, z - 15)
    pz, px, py = z - shift, x >> shift, y >> shift
    path = CACHE / "aws" / f"{pz}/{px}/{py}.png"
    if path.exists():
        data = path.read_bytes()
    else:
        data = http_get(AWS_TERRARIUM.format(z=pz, x=px, y=py))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    rgb = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.float64)
    elev = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
    if shift:
        k = 2**shift
        part = TILE // k
        ox, oy = (x - (px << shift)) * part, (y - (py << shift)) * part
        elev = np.kron(elev[oy : oy + part, ox : ox + part], np.ones((k, k)))
    return np.maximum(elev, 0)


def terrain_product(z):
    if z >= 15:
        return "dgm1"
    if z >= 11:
        return "dgm5"
    return None


def render_elevation(kind, z, x, y):
    out = np.full((TILE, TILE), np.nan)
    if kind == "dom" and z >= 14:
        # Max over all 1 m cells that fall into an output pixel.
        mpp = 40075016.686 * math.cos(math.radians(tile_center_lat(z, y))) / (TILE * 2**z)
        k = max(1, min(8, math.ceil(mpp)))
        lon, lat = tile_pixel_lonlat(z, x, y, k)
        east, north = lonlat_to_utm32(lon, lat)
        fine = np.full(east.shape, np.nan)
        sample_product("bdom", east, north, fine)
        fine = fine.reshape(TILE, k, TILE, k)
        with np.errstate(all="ignore"):
            out = np.where(np.isnan(fine).all(axis=(1, 3)), np.nan, np.nanmax(fine, axis=(1, 3)))

    lon, lat = tile_pixel_lonlat(z, x, y)
    product = terrain_product(z)
    if product and np.isnan(out).any():
        east, north = lonlat_to_utm32(lon, lat)
        sample_product(product, east, north, out)
    if np.isnan(out).any():
        out = np.where(np.isnan(out), aws_elevation(z, x, y), out)
    return encode_terrarium(out)


def render_view(kind, z, x, y):
    """Elevation for the 3D display: cached SH data where available, AWS elsewhere.

    Browsing must not trigger downloads, so only km tiles that an analysis already
    fetched are used. The result changes as the cache grows and is not cached itself.
    """
    out = np.full((TILE, TILE), np.nan)
    if z >= 9:
        lon, lat = tile_pixel_lonlat(z, x, y)
        east, north = lonlat_to_utm32(lon, lat)
        # Zoomed out, sample block means instead of single 1 m cells: cheaper, and
        # an honest picture of the surface instead of random hits on roofs and trees.
        mpp = 40075016.686 * math.cos(math.radians(tile_center_lat(z, y))) / (TILE * 2**z)
        cell = 25 if mpp >= 25 else 5 if mpp >= 5 else None
        products = (["bdom"] if kind == "view-dom" else []) + ["dgm1", "dgm5"]
        for product in products:
            sample_product(product, east, north, out, download=False, cell=cell)
            if not np.isnan(out).any():
                break
    if np.isnan(out).any():
        out = np.where(np.isnan(out), aws_elevation(z, x, y), out)
    return encode_terrarium(out)


def tile_center_lat(z, y):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 0.5) / 2**z))))


def encode_terrarium(elev):
    v = np.clip(elev + 32768, 0, 65535.996)
    r = np.floor(v / 256)
    g = np.floor(v - r * 256)
    b = np.floor((v - np.floor(v)) * 256)
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, "PNG")
    return buf.getvalue()


def render_dop(z, x, y):
    bbox = ",".join(f"{v:.3f}" for v in tile_bbox_3857(z, x, y))
    return http_get(DOP_WMS.format(bbox=bbox))


tile_locks = {}
tile_locks_guard = threading.Lock()


def cached_tile(kind, z, x, y):
    path = CACHE / "tiles" / kind / f"{z}/{x}/{y}.png"
    if path.exists():
        return path.read_bytes()
    with tile_locks_guard:
        lock = tile_locks.setdefault(path, threading.Lock())
    with lock:
        if path.exists():
            return path.read_bytes()
        data = render_dop(z, x, y) if kind == "dop" else render_elevation(kind, z, x, y)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        return data


# ---------------------------------------------------------------------------
# HTTP server

TILE_PATH = re.compile(r"^/tiles/(dop|dem|dom|view-dem|view-dom)/(\d+)/(\d+)/(\d+)\.png$")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        m = TILE_PATH.match(self.path.split("?")[0])
        if not m:
            return super().do_GET()
        kind, z, x, y = m[1], int(m[2]), int(m[3]), int(m[4])
        if z > 19 or not (0 <= x < 2**z and 0 <= y < 2**z) or (kind != "dop" and z > 16):
            return self.send_error(404)
        view = kind.startswith("view-")
        try:
            data = render_view(kind, z, x, y) if view else cached_tile(kind, z, x, y)
        except Exception as err:  # upstream failures should not kill the server
            print(f"tile {kind}/{z}/{x}/{y} failed: {err}", file=sys.stderr)
            return self.send_error(502, str(err))
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if view else "max-age=86400")
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        # Without this, browsers may keep using a cached older app.js after an update.
        if not self.path.startswith("/tiles/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith("/tiles/"):
            super().log_message(fmt, *args)


def main():
    global SSL_CTX
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--bind", default="127.0.0.1")
    args = parser.parse_args()

    SSL_CTX = make_ssl_context()
    server = ThreadingHTTPServer((args.bind, args.port), partial(Handler, directory=str(ROOT)))
    print(f"Plantenna running at http://{args.bind}:{args.port}/", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
