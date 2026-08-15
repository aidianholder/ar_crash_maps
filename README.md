# Arkansas Crash Map

An interactive map of ~400,000 Arkansas motor-vehicle crashes (2021–2025), served
as vector tiles from PostGIS via [Martin](https://martin.maplibre.org/) and
rendered with [MapLibre GL JS](https://maplibre.org/) on an
[OpenFreeMap](https://openfreemap.org/) *positron* basemap.

Density is shown as **equal-area hexbins** that get finer as you zoom in, then
switch to **individual crash points** at street level. Users can filter by
incident category (pedestrian, commercial-vehicle, impaired/DUI, fatal, injury)
and by year — all handled client-side against pre-aggregated tiles, so there are
no per-request database queries and everything stays CDN-cacheable.

---

## How it works

```
ardot_crashes.csv
      │  db/load.sh  (staging → typed table → geometry → hex aggregates)
      ▼
PostGIS  ─────────────────────────────────────────────┐
  crashes            (base table, 1 row per crash)     │
  hex_8km/3km/1km/400m (materialized views, per zoom)  │  Martin
  crash_points       (slim view for high zoom)         │  reads these as
      │                                                │  vector-tile sources
      ▼                                                ▼
   Martin  ──►  /<source>/{z}/{x}/{y}  (MVT tiles) ──►  nginx  ──►  browser
                                          same-origin /tiles proxy   MapLibre GL JS
```

**Why hexbins + tiles.** Shipping 400K points as GeoJSON would be ~100 MB and
slow to parse. Instead we pre-aggregate into hexagons in the database and serve
Mapbox Vector Tiles — the client only ever downloads the few small tiles in view.
Binning is done in **EPSG:5070 (CONUS Albers, equal-area)** so every hex covers
the same ground area (honest density), and the hex boundaries are stored in
EPSG:4326 for serving.

### Zoom ladder

| Web zoom | Layer          | Hex edge / detail        |
|---------:|----------------|--------------------------|
| ≤ 7      | `hex_8km`      | 8 km — statewide pattern |
| 8 – 9    | `hex_3km`      | 3 km — town / corridor   |
| 10 – 11  | `hex_1km`      | 1 km — neighborhood      |
| 12       | `hex_400m`     | 400 m — block cluster    |
| 13 +     | `crash_points` | individual crashes       |

### Filtering model

Each hex is pre-aggregated **per year**, plus an all-years rollup row
(`year = 0`), and carries several measure columns
(`crash_count`, `fatalities`, `injuries`, `cmv_count`, `ped_count`,
`impaired_count`). The frontend then does everything with MapLibre paint/filter
expressions — no parameterized SQL:

- **Filter by** picks which measure colors the hexes (and hides zero-value
  hexes), and applies the matching filter to the points layer.
- **Year** filters both hexes (to the chosen year bucket) and points.

At point zoom the legend switches to the KABCO crash-severity scale.

---

## Prerequisites

- **PostgreSQL 14+ with PostGIS 3.1+** (developed on Postgres.app 17 / PostGIS 3.5).
  PostGIS 3.1+ is required for `ST_HexagonGrid`.
- **Martin 1.x** — `brew install martin`, or the container image
  `ghcr.io/maplibre/martin` (used by `docker-compose.yml`).
- For the Docker stack: **Docker / Docker Compose**.
- The raw data file `ardot_crashes.csv` (ARDOT crash export).

---

## 1. Load the database

```bash
./db/load.sh /path/to/ardot_crashes.csv
```

This creates the `crashes` database, enables PostGIS, and runs the pipeline:

| Step | Script | What it does |
|------|--------|--------------|
| stage   | `db/01a_staging.sql` | all-text staging table matching the CSV columns |
| load    | *(in `load.sh`)*     | streams the CSV into staging, stripping the stray CR* |
| transform | `db/01b_transform.sql` | typed `crashes` table: dates/numerics cast, Yes/No → `boolean`, `geom` (Point 4326) built from lat/long, indexes |
| aggregate | `db/02_aggregates.sql` | `geom_5070` column, the four hex materialized views, and the `crash_points` view |

\* The ARDOT export has a **CRLF header but LF data rows**; PostgreSQL `COPY`
detects CRLF from the header and then rejects the LF rows. `load.sh` strips the
lone carriage return while streaming into `COPY` (no temp file, no 150 MB rewrite).

Connection is via standard libpq env vars (`PGHOST`, `PGUSER`, `PGDATABASE`, …).

### Refreshing after a new data load

The generated `geom_5070` column and `crash_points` view update automatically;
only the hex materialized views need rebuilding:

```bash
psql -d crashes -f db/03_refresh.sql
```

---

## 2. Serve the tiles + map

### Option A — Docker (production-portable)

`nginx` serves the web page and reverse-proxies `/tiles/*` to Martin on the same
origin (so there's no CORS to configure). The database is external — point
`DATABASE_URL` at it.

```bash
cp .env.example .env        # edit DATABASE_URL
docker compose up -d
open http://localhost:8080
```

### Option B — Local, native (no Docker)

```bash
# 1) tile server
DATABASE_URL="postgresql://$USER@localhost:5432/crashes" \
  martin --config martin/config.yaml          # serves on :3000

# 2) static web server
cd web && python3 -m http.server 8000

# 3) open the page, pointing it at the native Martin
open "http://localhost:8000/index.html?tiles=http://localhost:3000"
```

The page reads its tile base from `?tiles=`, defaulting to same-origin `/tiles`
(the nginx path). That's the only difference between the two setups.

---

## Configuration

- **`martin/config.yaml`** — publishes the five sources explicitly with per-source
  zoom bounds and `properties:` blocks.
  > Note: Martin does **not** auto-introspect columns for explicitly-configured
  > table sources — every tile property must be listed under `properties:`, or the
  > tiles ship geometry-only.
- **`.env` / `.env.example`** — `DATABASE_URL`. From a container reaching a DB on
  the host, use `host.docker.internal`.
- **`nginx/default.conf`** — static site + `/tiles/` → `martin:3000` proxy, with a
  1-hour tile cache header.

---

## Project layout

```
db/
  01a_staging.sql     text staging table (CSV column order)
  01b_transform.sql   typed crashes table + geometry + indexes
  02_aggregates.sql   geom_5070, hex materialized views, crash_points view
  03_refresh.sql      refresh the hex views after a data reload
  load.sh             end-to-end loader (CSV → serving-ready DB)
martin/
  config.yaml         Martin source definitions
nginx/
  default.conf        static + tile proxy (Docker stack)
web/
  index.html          the MapLibre application (self-contained)
docker-compose.yml    martin + nginx
.env.example          DATABASE_URL template
```

---

## Deployment notes

- **Portability:** every piece is parameterized by `DATABASE_URL`; the same files
  run locally or on a Linux server. The intended production target is Linux +
  Docker.
- **Read-only DB user:** the app only reads. Create a read-only role for
  production and put it in `DATABASE_URL`.
- **Caching:** tiles are effectively static between data refreshes — front them
  with a CDN and set a cache-busting step into your refresh process.
- **Tile size:** the widest tile (statewide z6, all year buckets) is ~200 KB raw
  but compresses well over the wire. If it ever matters, the year dimension can be
  stored as columns instead of rows to avoid repeating hex geometry.

---

## Data

Source: Arkansas Department of Transportation (ARDOT) crash export,
`ardot_crashes.csv` — 401,279 records, 399,812 with coordinates. Crash severity
uses the KABCO scale (K/A/B/C/O).
