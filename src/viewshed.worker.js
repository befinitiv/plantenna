// Viewshed computation worker.
//
// Fetches Terrarium-encoded elevation tiles around the antenna, assembles them into
// grids (in Web Mercator pixel space at the requested zoom) and runs a radial
// line-of-sight sweep. Two grids are used: the terrain (DGM), on which antenna and
// receiver heights are based, and optionally the surface incl. buildings and
// vegetation (bDOM), which acts as the obstacle model. The result is an RGBA image
// aligned to the same Mercator pixel grid so it can be draped onto the map.

const TILE = 256;
const BASE_ZOOM = 16; // finest elevation tiles (~1.4 m), used to sample the antenna base
const EARTH_RADIUS = 6371000;
const EARTH_CIRCUMFERENCE = 40075016.686;
const WAVELENGTH = 299792458 / 868e6; // m

// Values of the visibility grid.
const HIDDEN = 0;
const LINE_OF_SIGHT = 1; // direct line of sight, but the Fresnel zone is obstructed
const CLEAR = 2; // line of sight with the requested Fresnel zone clearance

const tileCache = new Map(); // url -> Promise<Float32Array | null>

function fetchTile(template, z, x, y) {
  const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  if (!tileCache.has(url)) {
    tileCache.set(url, decodeTerrarium(url).catch((err) => {
      tileCache.delete(url);
      console.warn('Elevation tile failed', url, err);
      return null;
    }));
  }
  return tileCache.get(url);
}

async function decodeTerrarium(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, TILE, TILE).data;
  const elev = new Float32Array(TILE * TILE);
  for (let i = 0; i < elev.length; i++) {
    const o = i * 4;
    elev[i] = px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768;
  }
  return elev;
}

function lonLatToWorld(lon, lat, worldSize) {
  const latR = (lat * Math.PI) / 180;
  return [
    ((lon + 180) / 360) * worldSize,
    ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * worldSize,
  ];
}

function tilesFor(z, x0, y0, W, H) {
  const n = 2 ** z;
  const tiles = [];
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + H - 1) / TILE); ty++) {
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + W - 1) / TILE); tx++) {
      tiles.push({ tx, ty, wrappedX: ((tx % n) + n) % n });
    }
  }
  return tiles;
}

async function sampleElevation(template, lon, lat) {
  const [wx, wy] = lonLatToWorld(lon, lat, TILE * 2 ** BASE_ZOOM);
  const tx = Math.floor(wx / TILE);
  const ty = Math.floor(wy / TILE);
  const tile = await fetchTile(template, BASE_ZOOM, tx, ty);
  if (!tile) throw new Error('Could not load the elevation at the antenna position.');
  return tile[Math.floor(wy - ty * TILE) * TILE + Math.floor(wx - tx * TILE)];
}

async function buildGrid(template, z, x0, y0, W, H, onTile) {
  const grid = new Float32Array(W * H);
  const tiles = await Promise.all(tilesFor(z, x0, y0, W, H).map(({ tx, ty, wrappedX }) =>
    fetchTile(template, z, wrappedX, ty).then((tile) => { onTile(); return { tx, ty, tile }; })));

  let missing = 0;
  for (const { tx, ty, tile } of tiles) {
    if (!tile) { missing++; continue; }
    // Overlap of this tile with the grid, in world pixels.
    const sx0 = Math.max(tx * TILE, x0);
    const sy0 = Math.max(ty * TILE, y0);
    const sx1 = Math.min((tx + 1) * TILE, x0 + W);
    const sy1 = Math.min((ty + 1) * TILE, y0 + H);
    for (let wy = sy0; wy < sy1; wy++) {
      const srcRow = (wy - ty * TILE) * TILE - tx * TILE;
      const dstRow = (wy - y0) * W - x0;
      for (let wx = sx0; wx < sx1; wx++) grid[dstRow + wx] = tile[srcRow + wx];
    }
  }
  return { grid, missing };
}

// Radial sweep: cast a ray from the antenna to every border cell of the grid and
// track the steepest obstacle elevation angle (slope) seen so far along the ray.
// A cell is in line of sight if the receiver point (terrain + rxHeight) lies at or
// above that slope.
//
// Fresnel clearance: the line of sight to a receiver at distance D must pass an
// obstacle at distance d with slope s by `fresnel` times the first Fresnel zone
// radius sqrt(λ·d·(D−d)/D). In slope terms the receiver needs
//   rxSlope >= s + fresnel·sqrt(λ·(1/d − 1/D)).
// An obstacle that is lower (in slope) than a nearer one can never be the limiting
// one, so only the obstacles that raised the maximum slope ("records") are checked.
// Records that cannot exceed the current maximum slope for any D are dropped.
function sweep(terrain, obstacles, W, H, cx, cy, zObs, rxHeight, mpp, radiusPx, kFactor, fresnel) {
  const visible = new Uint8Array(W * H);
  const curv = kFactor > 0 ? 1 / (2 * kFactor * EARTH_RADIUS) : 0;
  const r2 = radiusPx * radiusPx;
  const fresnelFactor = fresnel * Math.sqrt(WAVELENGTH);
  const recInvD = new Float64Array(Math.ceil(radiusPx) * 2 + 2); // 1/d of each record
  const recSlope = new Float64Array(recInvD.length);

  const castRay = (bx, by) => {
    const dx = bx - cx;
    const dy = by - cy;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
    let maxSlope = -Infinity;
    let nRec = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ix = Math.round(cx + dx * t);
      const iy = Math.round(cy + dy * t);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) break;
      const ddx = ix - cx;
      const ddy = iy - cy;
      const d2px = ddx * ddx + ddy * ddy;
      if (d2px > r2) break;
      if (d2px < 0.25) continue; // the antenna's own cell
      const d = Math.sqrt(d2px) * mpp;
      const drop = d * d * curv;
      const idx = iy * W + ix;
      const rxSlope = (terrain[idx] + rxHeight - drop - zObs) / d;
      if (rxSlope >= maxSlope) {
        let level = CLEAR;
        if (fresnel > 0) {
          const invD = 1 / d;
          for (let k = 0; k < nRec; k++) {
            if (rxSlope < recSlope[k] + fresnelFactor * Math.sqrt(recInvD[k] - invD)) {
              level = LINE_OF_SIGHT;
              break;
            }
          }
        }
        if (level > visible[idx]) visible[idx] = level;
      }
      const obstacleSlope = (obstacles[idx] - drop - zObs) / d;
      if (obstacleSlope > maxSlope) {
        maxSlope = obstacleSlope;
        if (fresnel > 0) {
          let kept = 0;
          for (let k = 0; k < nRec; k++) {
            if (recSlope[k] + fresnelFactor * Math.sqrt(recInvD[k]) > maxSlope) {
              recSlope[kept] = recSlope[k];
              recInvD[kept++] = recInvD[k];
            }
          }
          recSlope[kept] = obstacleSlope;
          recInvD[kept] = 1 / d;
          nRec = kept + 1;
        }
      }
    }
  };

  for (let x = 0; x < W; x++) { castRay(x, 0); castRay(x, H - 1); }
  for (let y = 1; y < H - 1; y++) { castRay(0, y); castRay(W - 1, y); }
  return visible;
}

self.onmessage = async (e) => {
  const {
    id, lon, lat, antennaHeight, rxHeight, radius, zoom, kFactor, fresnel, demUrl, domUrl, colors,
    baseElevation, baseUrl,
  } = e.data;
  try {
    const t0 = performance.now();
    const worldSize = TILE * 2 ** zoom;
    const [wx, wy] = lonLatToWorld(lon, lat, worldSize);
    const mpp = (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / worldSize;
    const radiusPx = radius / mpp;
    const rPx = Math.ceil(radiusPx) + 1;

    const x0 = Math.floor(wx) - rPx;
    const y0 = Math.floor(wy) - rPx;
    const W = 2 * rPx + 1;
    const H = 2 * rPx + 1;
    // Keep the overlay within the texture size every WebGL implementation supports.
    if (W > 4096) throw new Error('Area too large for this resolution — reduce radius or resolution.');

    const perGrid = tilesFor(zoom, x0, y0, W, H).length;
    const total = perGrid * (domUrl ? 2 : 1);
    let loaded = 0;
    const reportLoad = () =>
      self.postMessage({ id, type: 'progress', message: `Loading elevation data… ${loaded}/${total} tiles` });
    const onTile = () => { loaded++; reportLoad(); };
    reportLoad();

    const [terrain, surface] = await Promise.all([
      buildGrid(demUrl, zoom, x0, y0, W, H, onTile),
      domUrl ? buildGrid(domUrl, zoom, x0, y0, W, H, onTile) : null,
    ]);
    const obstacles = surface ? surface.grid : terrain.grid;
    if (surface) {
      // The surface can never be below the terrain (also covers failed tiles).
      for (let i = 0; i < obstacles.length; i++) {
        if (obstacles[i] < terrain.grid[i]) obstacles[i] = terrain.grid[i];
      }
    }

    self.postMessage({ id, type: 'progress', message: 'Computing line of sight…' });
    // Grid index i holds the elevation of the pixel centred at world x0 + i + 0.5.
    const cx = wx - x0 - 0.5;
    const cy = wy - y0 - 0.5;
    // The antenna base is sampled once when the antenna is placed; afterwards the
    // app passes it back so it stays put when settings change.
    const baseElev = baseElevation ?? await sampleElevation(baseUrl, lon, lat);
    const zObs = baseElev + antennaHeight;
    const visible = sweep(
      terrain.grid, obstacles, W, H, cx, cy, zObs, rxHeight, mpp, radiusPx, kFactor, fresnel,
    );

    const rgba = new Uint8ClampedArray(W * H * 4);
    let visibleCount = 0;
    let clearCount = 0;
    for (let i = 0; i < visible.length; i++) {
      if (visible[i] === HIDDEN) continue;
      visibleCount++;
      if (visible[i] === CLEAR) clearCount++;
      const color = visible[i] === CLEAR ? colors.clear : colors.obstructedFresnel;
      const o = i * 4;
      rgba[o] = color[0]; rgba[o + 1] = color[1]; rgba[o + 2] = color[2]; rgba[o + 3] = 255;
    }

    self.postMessage({
      id,
      type: 'result',
      width: W,
      height: H,
      rgba,
      zoom,
      x0,
      y0,
      stats: {
        baseElev,
        mpp,
        fresnel,
        visibleKm2: (visibleCount * mpp * mpp) / 1e6,
        clearKm2: (clearCount * mpp * mpp) / 1e6,
        circleKm2: (Math.PI * radius * radius) / 1e6,
        missingTiles: terrain.missing + (surface ? surface.missing : 0),
        totalTiles: total,
        ms: performance.now() - t0,
      },
    }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err.message || err) });
  }
};
