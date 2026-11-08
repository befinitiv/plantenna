# Plantenna

Browser tool for planning LoRa (868 MHz) antenna placement in Schleswig-Holstein: a 3D aerial-image map,
like Google Earth, with a line-of-sight overlay. Click the map to place the antenna. Every location where
a receiver at *receiver height* (1 m by default) above ground has direct line of sight to the antenna is
colored red.

## Run

```sh
uv run server.py            # or: pip install numpy pillow && python3 server.py
# open http://127.0.0.1:8000
```

## Data

All of these are open data from the Landesamt für Vermessung und Geoinformation Schleswig-Holstein,
© GeoBasis-DE/LVermGeo SH, licensed CC BY 4.0:

| Data | Used for | Source | Size per km² |
|---|---|---|---|
| DOP20 (20 cm aerial images) | map imagery | WMS `service.gdi-sh.de/WMS_SH_DOP20col_OpenGBD` | streamed |
| DGM5 (5 m terrain) | analysis at ~22 / 11 / 5.6 m resolution | download portal (XYZ) | ~1 MB |
| DGM1 (1 m terrain, laser scan) | analysis at ~2.8 / 1.4 m resolution | download portal (XYZ) | ~28 MB |
| bDOM (20 cm surface model incl. buildings and vegetation) | obstacles (optional) | download portal (GeoTIFF) | ~105 MB |

Outside Schleswig-Holstein, and over the sea, the server uses Esri World Imagery and the AWS Terrain Tiles
instead.

The 3D terrain on the map uses state data only where an analysis has already downloaded it (`cache/`).
Everywhere else it uses the AWS Terrain Tiles, because downloading DGM or bDOM for every area you browse
would be far too much. With the bDOM option on, the 3D view shows the surface model, including
buildings, hedges and trees; otherwise it shows the bare DGM terrain. Either way, the overlay lies on
the same data it was computed from. Buildings and trees appear as smooth shapes draped with the aerial
photo, not as modelled 3D buildings. When zoomed out, the view uses 5 m or 25 m block means, which the
server builds once per km tile and stores next to it in `cache/`. Individual buildings and hedges then
blend into raised areas such as forests and villages. Where cached state data meets the global terrain,
a small step can be visible.

## How it works

- `server.py` serves the app and works around two limitations of the state services. The services send
  no CORS headers, and the download server does not send its intermediate certificate. The server
  fetches that certificate from D-Trust and adds it, so connections are still fully verified.
  - `/tiles/dop/…` proxies the DOP20 WMS as Web Mercator tiles.
  - `/tiles/view-dem/…` and `/tiles/view-dom/…` serve the 3D display terrain from cached data only.
  - `/tiles/dem/…` and `/tiles/dom/…` download the 1 km × 1 km DGM and bDOM tiles (ETRS89 / UTM 32N)
    on demand. They are stored as int16 cm grids in `cache/`. The server reprojects them into
    Terrarium-encoded Web Mercator tiles. bDOM is max-pooled, so an obstacle anywhere in a cell blocks
    that cell.
- `src/viewshed.worker.js` stitches those tiles into grids and runs a radial sweep. Rays go from the
  antenna to every border cell, and the steepest obstacle angle (bDOM, or DGM when bDOM is off) is
  tracked along each ray. A cell is visible when its DGM height + receiver height lies at or above that
  angle. Earth curvature is applied with an effective radius factor k (4/3 for standard radio
  refraction).
- The **antenna base** is sampled once when the antenna is placed or dragged, from the finest
  elevation tiles (~1.4 m). With the bDOM option on, it is the surface (roof, hedge or tree top);
  otherwise it is the ground. The antenna height is added on top. The base then stays fixed, even if
  the option is toggled later. Receivers are always placed relative to the ground. The marker pin is
  drawn at the antenna elevation (base + height, times the terrain exaggeration), with a mast line
  down to the surface.
- With **Fresnel zone clearance** on, red means the path also clears the chosen fraction (60 % or
  100 %) of the first Fresnel zone at 868 MHz, which is `sqrt(λ·d·(D−d)/D)`, at every obstacle.
  Orange means direct line of sight with an obstructed Fresnel zone; expect extra loss there. Only
  obstacles that raised the maximum angle along a ray can be limiting, so the sweep checks just those.
  It matches a brute-force check exactly.
- **Height colours** (optional) colour the terrain height (DGM) with the *mako* colour scale. It contains
  no reds or yellows, so it stays distinct from the line-of-sight overlay. The tiles come from the
  same cache-only source as the 3D view (SH data around analysed areas, global terrain elsewhere) and
  are coloured in the browser. "Fit range to view" stretches the colours over the 2nd–98th percentile
  of the heights on screen.
- The result is published to the map as raster tiles cut from the result image (`viewshed://`
  protocol in `src/app.js`). A MapLibre image source would be clipped at tile boundaries on 3D
  terrain at some zoom levels.

The first analysis of an area downloads the source tiles; the panel shows an estimate. Later runs in the
same area come from `cache/` and take about a second. Delete `cache/` to free disk space.

## Limitations

- Diffraction over obstacles is not modeled. Orange and hidden areas may still be reachable with
  extra path loss.
- In bDOM mode, vegetation counts as a full block. At 868 MHz, foliage and Knicks attenuate the signal
  but do not block it completely, so links through a single hedge often still work. The bDOM result is
  pessimistic, and the terrain-only result is optimistic.
- The bDOM is derived from aerial images of varying age (see the tile dates in the download portal).
