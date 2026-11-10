// Plantenna — 3D satellite map with a line-of-sight overlay for antenna placement.

// Elevation for the line-of-sight analysis: Schleswig-Holstein DGM / bDOM via server.py.
const DEM_URL = '/tiles/dem/{z}/{x}/{y}.png';
const DOM_URL = '/tiles/dom/{z}/{x}/{y}.png';
// The 3D map display uses SH data only where an analysis already downloaded it
// (downloading it for every area while browsing would be far too much) and the
// global terrain tiles elsewhere. It shows the surface (bDOM) when that is the
// obstacle model of the analysis, so the overlay lies on the data it came from.
const VIEW_TERRAIN_URL = { terrain: '/tiles/view-dem/{z}/{x}/{y}.png', surface: '/tiles/view-dom/{z}/{x}/{y}.png' };
const SATELLITE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const SH_BOUNDS = [7.85, 53.35, 11.35, 55.06];
const SH_ATTRIBUTION = '© GeoBasis-DE/LVermGeo SH/CC BY 4.0';
const CLEAR_COLOR = [255, 30, 30];
const OBSTRUCTED_FRESNEL_COLOR = [255, 170, 0];
// Download volume of the source data per km², used for the estimate in the panel.
const MB_PER_KM2 = { dgm5: 1.1, dgm1: 28, bdom: 105 };

const $ = (id) => document.getElementById(id);

const map = new maplibregl.Map({
  container: 'map',
  center: [9.8, 54.2],
  zoom: 8,
  pitch: 45,
  maxPitch: 85,
  style: {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      satellite: {
        type: 'raster',
        tiles: [SATELLITE_URL],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      },
      dop: {
        type: 'raster',
        tiles: ['/tiles/dop/{z}/{x}/{y}.png'],
        tileSize: 256,
        minzoom: 9,
        maxzoom: 18,
        bounds: SH_BOUNDS,
        attribution: `DOP20, DGM, bDOM ${SH_ATTRIBUTION}`,
      },
      terrain: terrainSource(0),
      radius: { type: 'geojson', data: emptyFeatures() },
      peaks: { type: 'geojson', data: emptyFeatures() },
    },
    layers: [
      { id: 'satellite', type: 'raster', source: 'satellite' },
      { id: 'dop', type: 'raster', source: 'dop' },
      {
        id: 'radius',
        type: 'line',
        source: 'radius',
        paint: { 'line-color': '#ffcc00', 'line-width': 2, 'line-dasharray': [2, 2] },
      },
      {
        id: 'high-peaks',
        type: 'circle',
        source: 'peaks',
        filter: ['==', ['get', 'kind'], 'high'],
        paint: {
          'circle-color': '#8be9fd',
          'circle-radius': 6,
          'circle-stroke-color': '#111',
          'circle-stroke-width': 2,
        },
      },
      {
        id: 'peak-labels-high',
        type: 'symbol',
        source: 'peaks',
        filter: ['==', ['get', 'kind'], 'high'],
        layout: {
          'text-field': ['get', 'label'], 'text-size': 11, 'text-offset': [0, 1.2],
          'text-allow-overlap': true, 'text-ignore-placement': true,
        },
        paint: { 'text-color': '#fff', 'text-halo-color': '#111', 'text-halo-width': 1 },
      },
    ],
    terrain: { source: 'terrain', exaggeration: 1 },
    sky: {
      'sky-color': '#7fb2e5',
      'horizon-color': '#d8e6f3',
      'sky-horizon-blend': 0.6,
      'fog-color': '#d8e6f3',
      'horizon-fog-blend': 0.3,
    },
  },
});

map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.TerrainControl({ source: 'terrain', exaggeration: 1 }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

// ---------------------------------------------------------------------------
// Antenna placement

let antenna = null; // {lng, lat}
const marker = new maplibregl.Marker({ color: '#ffcc00', draggable: true });

marker.on('dragend', () => setAntenna(marker.getLngLat()));
map.on('click', (e) => setAntenna(e.lngLat));
map.on('load', () => map.getCanvas().style.cursor = 'crosshair');
function showPeakPopup(e) {
  const point = e.features?.[0];
  if (!point) return;
  new maplibregl.Popup()
    .setLngLat(e.lngLat)
    .setHTML(`<strong>${point.properties.elevation} m</strong><br>${Number(point.properties.distance).toFixed(0)} m from antenna`)
    .addTo(map);
}
for (const layer of ['high-peaks']) {
  map.on('click', layer, showPeakPopup);
  map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = 'crosshair'; });
}

// Markers sit on the displayed terrain, so the pin is lifted to the antenna
// elevation with its offset, and a line (the mast) connects it to the ground.
const mast = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
mast.id = 'mast';
mast.innerHTML = '<line stroke="#ffcc00" stroke-width="3" stroke-linecap="round" />';
map.getCanvasContainer().appendChild(mast);

function updateMast() {
  const line = mast.firstChild;
  const height = Number($('antenna-height').value);
  const terrain = map.getTerrain();
  // Until the new base is known after moving the antenna, keep the previous one.
  const base = antenna?.base ?? antenna?.previousBase ?? null;
  if (!antenna || (terrain && base === null)) {
    marker.setOffset([0, 0]);
    line.setAttribute('visibility', 'hidden');
    return;
  }
  // While the terrain reloads (after each analysis) MapLibre reports 0 m ground
  // height; keep the mast as it is until the elevation tiles are back.
  if (terrain && !map.isSourceLoaded('terrain')) return;
  // Scene heights are elevations times the terrain exaggeration. Without terrain
  // the map is flat at 0 m, so only the mast height is shown.
  const elevation = terrain ? (base + height) * (terrain.exaggeration ?? 1) : height;
  const lngLat = marker.getLngLat();
  const transform = map.transform;
  const top = transform.coordinatePoint(
    maplibregl.MercatorCoordinate.fromLngLat(lngLat), elevation, transform.pixelMatrix3D,
  );
  const ground = map.project(lngLat);
  marker.setOffset([top.x - ground.x, top.y - ground.y]);
  line.setAttribute('x1', ground.x);
  line.setAttribute('y1', ground.y);
  line.setAttribute('x2', top.x);
  line.setAttribute('y2', top.y);
  line.setAttribute('visibility', 'visible');
}

map.on('render', updateMast);
marker.on('drag', updateMast);

function setAntenna(lngLat) {
  // The base (ground, or roof/vegetation with bDOM on) is determined by the first
  // analysis after placing and then kept, also when the checkbox changes later.
  antenna = {
    lng: lngLat.lng,
    lat: lngLat.lat,
    base: null,
    baseOnSurface: $('surface').checked,
    previousBase: antenna?.base ?? antenna?.previousBase ?? null,
  };
  marker.setLngLat(lngLat).addTo(map);
  updateRadiusCircle();
  updatePeaks();
  scheduleCompute();
}

function updateRadiusCircle() {
  if (!antenna || !map.getSource('radius')) return;
  const radius = Number($('radius').value) * 1000;
  const coords = [];
  const latR = (antenna.lat * Math.PI) / 180;
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * 2 * Math.PI;
    coords.push([
      antenna.lng + ((radius * Math.sin(a)) / (111320 * Math.cos(latR))),
      antenna.lat + (radius * Math.cos(a)) / 110540,
    ]);
  }
  map.getSource('radius').setData({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }],
  });
}

async function updatePeaks() {
  const source = map.getSource('peaks');
  if (!source) return;
  if (!antenna || !$('peaks-on').checked) {
    source.setData(emptyFeatures());
    return;
  }
  setStatus('Loading high terrain points…');
  try {
    const baseParams = {
      lon: antenna.lng,
      lat: antenna.lat,
      radius: $('radius').value,
      count: $('peaks-count').value,
    };
    const modes = ['high'];
    const results = await Promise.all(modes.map(async (mode) => {
      const params = new URLSearchParams({ ...baseParams, mode });
      const res = await fetch(`/api/elevation-peaks?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { points } = await res.json();
      return points.map((point) => ({ ...point, kind: mode }));
    }));
    const points = results.flat();
    source.setData({
      type: 'FeatureCollection',
      features: points.map((point) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
        properties: {
          kind: point.kind,
          elevation: point.elevation,
          distance: point.distance,
          label: `${point.kind === 'high' ? 'H' : 'L'}: ${point.elevation.toFixed(1)} m`,
        },
      })),
    });
    setStatus(`${$('peaks-count').value} high terrain points loaded.`);
  } catch (err) {
    source.setData(emptyFeatures());
    setStatus(`High terrain points failed: ${err.message}`, true);
  }
}

function emptyFeatures() {
  return { type: 'FeatureCollection', features: [] };
}

// ---------------------------------------------------------------------------
// Viewshed computation (in a worker)

const worker = new Worker('src/viewshed.worker.js');
let jobId = 0;
let computeTimer = null;

// The computed overlay is published as raster tiles cut from the result image.
// (A MapLibre image source draped on terrain gets clipped at tile boundaries at
// some zoom levels; tile sources do not have that problem.)
let overlay = null; // {canvas, zoom, x0, y0}
const EMPTY_TILE = (() => {
  const canvas = new OffscreenCanvas(256, 256);
  canvas.getContext('2d');
  return canvas.convertToBlob().then((b) => b.arrayBuffer());
})();

maplibregl.addProtocol('viewshed', async ({ url }) => {
  const [, z, x, y] = url.match(/(\d+)\/(\d+)\/(\d+)$/).map(Number);
  const scale = overlay ? 2 ** (overlay.zoom - z) : 0; // overlay pixels per tile pixel
  const sx = x * 256 * scale - (overlay?.x0 ?? 0);
  const sy = y * 256 * scale - (overlay?.y0 ?? 0);
  const size = 256 * scale;
  if (!overlay || sx >= overlay.canvas.width || sy >= overlay.canvas.height || sx + size <= 0 || sy + size <= 0) {
    return { data: (await EMPTY_TILE).slice(0) };
  }
  const tile = new OffscreenCanvas(256, 256);
  const ctx = tile.getContext('2d');
  ctx.imageSmoothingEnabled = scale > 1; // average when zoomed out, crisp cells when zoomed in
  ctx.drawImage(overlay.canvas, sx, sy, size, size, 0, 0, 256, 256);
  return { data: await (await tile.convertToBlob()).arrayBuffer() };
});

function scheduleCompute() {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(compute, 250);
}

function compute() {
  if (!antenna) return;
  jobId++;
  setStatus('Computing…');
  worker.postMessage({
    id: jobId,
    lon: antenna.lng,
    lat: antenna.lat,
    antennaHeight: Number($('antenna-height').value),
    rxHeight: Number($('rx-height').value),
    radius: Number($('radius').value) * 1000,
    zoom: Number($('zoom').value),
    kFactor: Number($('kfactor').value),
    demUrl: DEM_URL,
    baseElevation: antenna.base,
    baseUrl: antenna.baseOnSurface ? DOM_URL : DEM_URL,
    domUrl: $('surface').checked ? DOM_URL : null,
    fresnel: Number($('fresnel').value),
    colors: { clear: CLEAR_COLOR, obstructedFresnel: OBSTRUCTED_FRESNEL_COLOR },
  });
}

worker.onmessage = async (e) => {
  const msg = e.data;
  if (msg.id !== jobId) return; // stale result from a superseded request
  if (msg.type === 'progress') return setStatus(msg.message);
  if (msg.type === 'error') return setStatus(msg.message, true);

  const canvas = new OffscreenCanvas(msg.width, msg.height);
  canvas.getContext('2d').putImageData(new ImageData(msg.rgba, msg.width, msg.height), 0, 0);
  overlay = { canvas, zoom: msg.zoom, x0: msg.x0, y0: msg.y0 };
  showOverlay(msg.id);
  showStats(msg.stats);
  refreshViewTerrain(msg.id); // the analysis may have added data to the server cache
};

function viewTerrainUrl(version) {
  const url = VIEW_TERRAIN_URL[$('surface').checked ? 'surface' : 'terrain'];
  return `${url}?v=${version}`;
}

function terrainSource(version) {
  return {
    type: 'raster-dem',
    tiles: [viewTerrainUrl(version)],
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 16,
    attribution: 'Terrain outside analysed areas: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles (AWS Open Data)</a>',
  };
}

// MapLibre's terrain keeps the elevation tiles it has loaded when only the tile
// URL of its source changes, so the source is replaced instead.
function refreshViewTerrain(version) {
  refreshHeightTiles(); // same data as the height colours
  if (!map.getSource('terrain')) return;
  const terrain = map.getTerrain();
  if (terrain) map.setTerrain(null);
  map.removeSource('terrain');
  map.addSource('terrain', terrainSource(version));
  if (terrain) map.setTerrain({ ...terrain });
}

function showOverlay(id) {
  // A new URL per result so MapLibre does not reuse tiles of the previous one.
  const tiles = [`viewshed://${id}/{z}/{x}/{y}`];
  const source = map.getSource('viewshed');
  if (source) {
    source.setTiles(tiles);
    return;
  }
  map.addSource('viewshed', { type: 'raster', tiles, tileSize: 256, maxzoom: 20 });
  map.addLayer(
    {
      id: 'viewshed',
      type: 'raster',
      source: 'viewshed',
      paint: {
        'raster-opacity': Number($('opacity').value),
        'raster-opacity-transition': { duration: 0 }, // see the opacity input handler
        'raster-fade-duration': 0,
      },
    },
    'radius',
  );
}

function setStatus(text, isError = false) {
  const el = $('status-msg');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function showStats(s) {
  const h = Number($('antenna-height').value);
  $('stats').hidden = false;
  $('s-pos').textContent = `${antenna.lat.toFixed(5)}, ${antenna.lng.toFixed(5)}`;
  antenna.base ??= s.baseElev;
  updateMast();
  $('s-ground').textContent =
    `${antenna.base.toFixed(1)} m (${antenna.baseOnSurface ? 'surface' : 'ground'})`;
  $('s-antenna').textContent = `${(antenna.base + h).toFixed(1)} m`;
  $('s-res').textContent = `${s.mpp.toFixed(1)} m/px`;
  $('s-area').textContent =
    `${s.visibleKm2.toFixed(2)} km² (${((100 * s.visibleKm2) / s.circleKm2).toFixed(0)} %)`;
  $('s-clear').textContent =
    `${s.clearKm2.toFixed(2)} km² (${((100 * s.clearKm2) / s.circleKm2).toFixed(0)} %)`;
  for (const el of document.querySelectorAll('.fresnel-stat')) el.hidden = !s.fresnel;
  let text = `Done in ${(s.ms / 1000).toFixed(1)} s.`;
  if (s.missingTiles) text += ` ${s.missingTiles}/${s.totalTiles} terrain tiles failed to load.`;
  setStatus(text, s.missingTiles > 0);
}

// ---------------------------------------------------------------------------
// Controls

$('antenna-height').addEventListener('input', updateMast);
for (const id of ['antenna-height', 'rx-height', 'kfactor', 'fresnel']) {
  $(id).addEventListener('input', scheduleCompute);
}
$('surface').addEventListener('input', () => refreshViewTerrain(jobId));
for (const id of ['radius', 'zoom', 'surface']) {
  $(id).addEventListener('input', () => {
    updateSurfaceOption();
    updateDataEstimate();
    updateRadiusCircle();
    updatePeaks();
    scheduleCompute();
  });
}
$('peaks-on').addEventListener('input', updatePeaks);
$('peaks-count').addEventListener('input', updatePeaks);

// bDOM tiles are only produced at ~5.6 m resolution or finer.
function updateSurfaceOption() {
  const surface = $('surface').checked;
  for (const opt of $('zoom').options) opt.disabled = surface && Number(opt.value) < 14;
  if (surface && Number($('zoom').value) < 14) $('zoom').value = '14';
}

// Rough size of the first-time download from LVermGeo SH for the current settings
// (the analysis covers a square around the circle). Cached data is not counted.
function updateDataEstimate() {
  const side = 2 * Number($('radius').value) + 1;
  const terrain = Number($('zoom').value) >= 15 ? 'dgm1' : 'dgm5';
  let mb = side * side * MB_PER_KM2[terrain];
  if ($('surface').checked) mb += side * side * MB_PER_KM2.bdom;
  const size = mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.ceil(mb)} MB`;
  $('data-estimate').textContent =
    `First analysis of an area downloads up to ~${size} from LVermGeo SH; it is cached afterwards.`;
}

function updateLegend() {
  $('legend').hidden = Number($('fresnel').value) === 0;
}
$('fresnel').addEventListener('input', updateLegend);

updateSurfaceOption();
updateDataEstimate();
updateLegend();
function setLayerOpacity(layer, value) {
  if (!map.getLayer(layer)) return;
  map.setPaintProperty(layer, 'raster-opacity', value);
  // Layers draped on the 3D terrain are cached as textures, and a paint change
  // does not invalidate them.
  map.terrain?.sourceCache.freeRtt();
  map.triggerRepaint();
}
$('opacity').addEventListener('input', (e) => setLayerOpacity('viewshed', Number(e.target.value)));
$('exaggeration').addEventListener('input', (e) => {
  if (map.getTerrain()) map.setTerrain({ source: 'terrain', exaggeration: Number(e.target.value) });
});

$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search-q').value.trim();
  if (!q) return;

  const coords = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coords) {
    map.flyTo({ center: [Number(coords[2]), Number(coords[1])], zoom: 14 });
    return;
  }

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
    );
    const [hit] = await res.json();
    if (!hit) return setStatus(`Nothing found for “${q}”.`, true);
    map.flyTo({ center: [Number(hit.lon), Number(hit.lat)], zoom: 14 });
  } catch (err) {
    setStatus(`Search failed: ${err.message}`, true);
  }
});

// ---------------------------------------------------------------------------
// False-colour height overlay
//
// Colours the terrain height (DGM) of the tiles that also feed the 3D view:
// cached SH data around analysed areas, global terrain elsewhere. Tiles are
// coloured in the browser so that changing the range needs no server work.

// "mako" colour scale: perceptually ordered, and without the reds and yellows of
// the line-of-sight overlay.
const HEIGHT_COLORS = [
  [46, 30, 60], [65, 61, 123], [55, 101, 158], [52, 143, 167], [64, 183, 173],
  [138, 217, 177], [222, 245, 229],
];
const HEIGHT_LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (HEIGHT_COLORS.length - 1);
    const k = Math.min(Math.floor(t), HEIGHT_COLORS.length - 2);
    const f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(HEIGHT_COLORS[k][c] * (1 - f) + HEIGHT_COLORS[k + 1][c] * f);
  }
  return lut;
})();

const heightTiles = new Map(); // "z/x/y" -> Promise<Float32Array> (decoded elevations)
const heightDecoded = new Map(); // "z/x/y" -> Float32Array, for fitting the range
const HEIGHT_TILES_MAX = 300;
let heightVersion = 0;
let heightFitted = false;

async function decodeTerrariumUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const elev = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0; i < elev.length; i++) {
    elev[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  }
  return elev;
}

function heightTile(key) {
  if (!heightTiles.has(key)) {
    if (heightTiles.size >= HEIGHT_TILES_MAX) {
      const oldest = heightTiles.keys().next().value;
      heightTiles.delete(oldest);
      heightDecoded.delete(oldest);
    }
    const promise = decodeTerrariumUrl(VIEW_TERRAIN_URL.terrain.replace('{z}/{x}/{y}', key));
    promise.then((elev) => heightDecoded.set(key, elev), () => heightTiles.delete(key));
    heightTiles.set(key, promise);
  }
  return heightTiles.get(key);
}

// URL: height://<version>/<min>/<max>/<z>/<x>/<y>
maplibregl.addProtocol('height', async ({ url }) => {
  const [, min, max, z, x, y] = url.slice('height://'.length).split('/').map(Number);
  const elev = await heightTile(`${z}/${x}/${y}`);
  const size = Math.sqrt(elev.length);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const scale = 255 / Math.max(max - min, 0.1);
  for (let i = 0; i < elev.length; i++) {
    const v = Math.min(255, Math.max(0, Math.round((elev[i] - min) * scale))) * 3;
    img.data[i * 4] = HEIGHT_LUT[v];
    img.data[i * 4 + 1] = HEIGHT_LUT[v + 1];
    img.data[i * 4 + 2] = HEIGHT_LUT[v + 2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { data: await (await canvas.convertToBlob()).arrayBuffer() };
});

function heightTilesUrl() {
  return `height://${heightVersion}/${Number($('height-min').value)}/${Number($('height-max').value)}/{z}/{x}/{y}`;
}

function showHeightOverlay() {
  const on = $('height-on').checked;
  $('height-controls').hidden = !on;
  if (!map.getSource('height')) {
    if (!on) return;
    map.addSource('height', { type: 'raster', tiles: [heightTilesUrl()], tileSize: 256, maxzoom: 16 });
    map.addLayer(
      {
        id: 'height',
        type: 'raster',
        source: 'height',
        paint: {
          'raster-opacity': Number($('height-opacity').value),
          'raster-opacity-transition': { duration: 0 }, // see setLayerOpacity
          'raster-fade-duration': 0,
        },
      },
      map.getLayer('viewshed') ? 'viewshed' : 'radius',
    );
  }
  map.setLayoutProperty('height', 'visibility', on ? 'visible' : 'none');
  if (on && !heightFitted) {
    heightFitted = true;
    map.once('idle', fitHeightRange);
  }
}

function updateHeightRange() {
  $('height-min-label').textContent = `${$('height-min').value} m`;
  $('height-max-label').textContent = `${$('height-max').value} m`;
  map.getSource('height')?.setTiles([heightTilesUrl()]);
}

// Data changed on the server (an analysis cached more SH data): decode again.
function refreshHeightTiles() {
  heightTiles.clear();
  heightDecoded.clear();
  heightVersion++;
  map.getSource('height')?.setTiles([heightTilesUrl()]);
}

// Stretch the colours over the heights on screen (2nd to 98th percentile).
function fitHeightRange() {
  const sourceCache = map.style.sourceCaches.height;
  if (!sourceCache) return;
  const samples = [];
  for (const id of sourceCache.getVisibleCoordinates()) {
    const { z, x, y } = id.canonical;
    const elev = heightDecoded.get(`${z}/${x}/${y}`);
    if (!elev) continue;
    for (let i = 0; i < elev.length; i += 97) samples.push(elev[i]);
  }
  if (!samples.length) return;
  samples.sort((a, b) => a - b);
  let min = Math.floor(samples[Math.floor(samples.length * 0.02)]);
  let max = Math.ceil(samples[Math.floor(samples.length * 0.98)]);
  if (max - min < 2) { min -= 1; max += 1; }
  $('height-min').value = min;
  $('height-max').value = max;
  updateHeightRange();
}

$('height-legend').style.background = `linear-gradient(to right, ${HEIGHT_COLORS.map((c) => `rgb(${c})`).join(', ')})`;
$('height-on').addEventListener('input', showHeightOverlay);
$('height-min').addEventListener('input', updateHeightRange);
$('height-max').addEventListener('input', updateHeightRange);
$('height-fit').addEventListener('click', fitHeightRange);
$('height-opacity').addEventListener('input', (e) => setLayerOpacity('height', Number(e.target.value)));
updateHeightRange();
