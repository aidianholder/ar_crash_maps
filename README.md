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
      │  db/setup-docker.sh  (Docker PostGIS)   ──or──   db/load.sh  (existing PG)
      │  staging → typed table → geometry → hex aggregates
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

### Map interface

- **Filter by** — crash count, fatalities, serious injuries, pedestrian,
  commercial-vehicle, or impaired/DUI. Recolors the hexes by that measure (hiding
  zero-value hexes) and filters the crash points to matching incidents.
- **Year** — all years, or 2021–2025; filters both hexes and points.
- **Legend** swaps to the KABCO severity key at point zoom; a **scale bar** sits
  bottom-left.
- **Popups** — hover a hex for its counts; click a crash for date/time, city,
  agency, road-surface & lighting conditions, and crash description.
- **State cutout** — everything outside Arkansas is masked with a boundary
  outline, and Arkansas **city labels** (Census places, sized by population with
  collision detection) are drawn on top at hex zoom levels.

These are all in the single self-contained `web/index.html`, driven by MapLibre
paint/filter expressions plus two small local GeoJSON assets (state boundary and
city labels).

---

## Prerequisites

- **PostgreSQL 14+ with PostGIS 3.1+** (developed on Postgres.app 17 / PostGIS 3.5) —
  or skip the local install and run it in Docker via `db/setup-docker.sh`.
  PostGIS 3.1+ is required for `ST_HexagonGrid`.
- **Martin 1.x** — `brew install martin`, or the container image
  `ghcr.io/maplibre/martin` (used by `docker-compose.yml`).
- For the Docker stack: **Docker / Docker Compose**.
- The raw data file `ardot_crashes.csv` (ARDOT crash export).

---

## 1. Load the database

Two ways to reach a serving-ready `crashes` database, depending on whether you
want PostGIS in Docker or already run a PostgreSQL server. Both run the same
pipeline.

### Option A — PostGIS in Docker (one command)

`db/setup-docker.sh` launches the official `postgis/postgis` image (PostGIS is
already baked in — "installing" it just means pulling the image), waits for it,
creates the `crashes` database, enables PostGIS, and runs the load. **All `psql`
runs inside the container**, so the host needs only Docker + bash.

```bash
./db/setup-docker.sh /path/to/ardot_crashes.csv    # provision + load
./db/setup-docker.sh                               # provision an empty DB only
```

Data persists in a named volume; defaults are overridable via env (`IMAGE`,
`PGPASSWORD`, `HOST_PORT`, `DB`, `VOLUME`, `CONTAINER`). The script prints the
`DATABASE_URL` to drop into `.env` — Martin reaches this DB at
`host.docker.internal:<HOST_PORT>` (on Linux, uncomment the `extra_hosts` lines
under `martin` in `docker-compose.yml`).

### Option B — an existing PostgreSQL server

`db/load.sh` runs the pipeline against a server you already have, via standard
libpq env vars (`PGHOST`, `PGUSER`, `PGDATABASE`, …):

```bash
./db/load.sh /path/to/ardot_crashes.csv
```

### The pipeline (both paths)

| Step | Script | What it does |
|------|--------|--------------|
| stage   | `db/01a_staging.sql` | all-text staging table matching the CSV columns |
| load    | *(in the script)*    | streams the CSV into staging, stripping the stray CR* |
| transform | `db/01b_transform.sql` | typed `crashes` table: dates/numerics cast, Yes/No → `boolean`, `geom` (Point 4326) from lat/long, indexes |
| aggregate | `db/02_aggregates.sql` | `geom_5070` column, the four per-year hex materialized views, and the `crash_points` view |

\* The ARDOT export has a **CRLF header but LF data rows**; PostgreSQL `COPY`
detects CRLF from the header and then rejects the LF rows. Both scripts strip the
lone carriage return while streaming into `COPY` (no temp file, no 150 MB rewrite).

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
`DATABASE_URL` at it. If you used `db/setup-docker.sh`, use the `DATABASE_URL` it
printed (`host.docker.internal:<HOST_PORT>`), and on Linux uncomment the
`extra_hosts` lines under `martin` in `docker-compose.yml`.

```bash
cp .env.example .env        # set DATABASE_URL
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

## 3. Embed the map in someone else's page

`web/embed.js` is the same map packaged for a page on another site (the intended
consumer is an article on arkansasonline.com). The whole integration is:

```html
<div id="ar-crash-map" data-height="70vh"></div>
<script src="https://maps.arkansasonline.com/crashes/embed.js"></script>
```

It loads MapLibre, injects its own styles, builds the controls and renders into
the container. `web/embed-example.html` is a live preview and integration
reference. Optional container attributes: `data-height`, `data-center="lng,lat"`,
`data-zoom`, `data-measure`, `data-year`, `data-title`, `data-hint`,
`data-source`; several maps on one page use the `ar-crash-map` class instead of
the id, and `ARCrashMap.init(el)` places one manually (for tabs or lazily-rendered
modules).

The chrome is part of the page rather than a floating overlay — title, the two
filters side by side (stacking when the container is narrow), a centered note,
the map, then a hexagon badge showing the current bin size next to a horizontal
legend, and a source line. `data-height` therefore sizes the **map**, not the
whole block, which is taller by the height of the controls and legend.
`data-title=""`, `data-hint=""` and `data-source=""` drop those lines. The badge
hides itself at z13+, where crashes are drawn individually and nothing is binned.

`index.html` can't simply be pasted into another page — the embed exists because
three things in it only work on the map's own origin:

| | `index.html` | `embed.js` |
|---|---|---|
| Tiles | same-origin `/tiles` | absolute URL, served with `Access-Control-Allow-Origin` |
| GeoJSON assets | relative (`arkansas.geojson`) | absolute URL + CORS |
| DOM | document-global ids (`#map`, `#measure`) | scoped to the container |
| CSS | bare tag/id selectors | `.arcm-*`, namespaced against the host page's styles |
| MapLibre | unpkg CDN | `web/vendor/`, served from our own origin |

Two non-obvious constraints, both load-bearing:

- **CSS specificity, not just naming.** MapLibre's stylesheet is injected *after*
  the embed's and contains `.maplibregl-map{position:relative}`. A single-class
  rule like `.arcm-map{position:absolute;inset:0}` ties on specificity and loses
  on source order — which silently collapses the map container to zero height.
  Every embed rule is therefore scoped under `.arcm-root` (two classes). The
  standalone page is immune only because it happens to style `#map` by id.
- **Vendored MapLibre.** Serving the library from this origin keeps the embed
  working if unpkg is unreachable, and means a host page's CSP only has to allow
  `maps.arkansasonline.com` plus the basemap host `tiles.openfreemap.org`.

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
  02_aggregates.sql   geom_5070, per-year hex materialized views, crash_points view
  03_refresh.sql      refresh the hex views after a data reload
  04_grants.sql       create the read-only `crashes_ro` serving role (idempotent)
  load.sh             loader against an existing PostgreSQL server
  setup-docker.sh     stand up PostGIS in Docker and load, in one command
martin/
  config.yaml         Martin source definitions
nginx/
  default.conf        static + tile proxy (Docker stack)
web/
  index.html          the MapLibre application (self-contained)
  embed.js            the same map, packaged as a drop-in embed for another site
  embed-example.html  integration example / preview for embed.js
  diagnose.html       on-page diagnostics for "map renders but no data"
  vendor/             MapLibre GL JS 4.7.1 (js + css), served from our own origin
  arkansas.geojson    simplified state boundary (cutout mask + outline)
  ar_cities.geojson   Arkansas city labels (Census place + 2023 population)
docker-compose.yml    martin + nginx
.env.example          DATABASE_URL template
```

---

## Deployment notes

- **Portability:** every piece is parameterized by `DATABASE_URL`; the same files
  run locally or on a Linux server. The intended production target is Linux +
  Docker.
- **Read-only DB user:** the app only reads, so Martin connects as `crashes_ro` —
  a `LOGIN NOSUPERUSER` role with `SELECT` on exactly the five published sources
  and nothing else. `db/04_grants.sql` creates it and is idempotent:

  ```bash
  docker exec -i ar_crashes_db psql -v ON_ERROR_STOP=1 -U postgres -d crashes \
    -v ro_password='...' < db/04_grants.sql
  ```

  Two things make this less work than it looks. `crash_points` is a plain view and
  a view executes with its *owner's* privileges, so the role needs no rights on the
  38-column `crashes` base table — and gets none. And `GRANT SELECT ON ALL TABLES
  IN SCHEMA` silently skips materialized views, so the `hex_*` views are listed
  explicitly rather than relying on that form.

- **Loading stays separate from serving.** The two roles never trade places:
  `setup-docker.sh` and `load.sh` connect as the owner (`postgres`) through their
  own `PGUSER`, while `.env`/`DATABASE_URL` is read *only* by Martin. Reloading
  data or re-running the pipeline therefore needs no change to `.env` and no
  switch back to the superuser. `02_aggregates.sql` drops and recreates the hex
  matviews — which discards their grants — but the `ALTER DEFAULT PRIVILEGES` in
  `04_grants.sql` re-applies `SELECT` to anything the owner creates in the schema
  afterwards (verified on PG17: unlike `GRANT ... ON ALL TABLES`, default
  privileges *do* cover materialized views), so tile serving survives a reload
  untouched. Re-run `04_grants.sql` only if you change the set of published
  sources or rebuild the database from scratch.
- **Caching:** tiles are effectively static between data refreshes — front them
  with a CDN and set a cache-busting step into your refresh process.
- **Tile size:** the widest tile (statewide z6, all year buckets) is ~200 KB raw
  but compresses well over the wire. If it ever matters, the year dimension can be
  stored as columns instead of rows to avoid repeating hex geometry.

### The live deployment

Running on the Linux/Docker box behind `maps.arkansasonline.com`, alongside other
sites. Where it departs from the generic instructions above, and why — each of
these will bite anyone who redeploys by following section 2 literally:

| | Generic instructions | As deployed |
|---|---|---|
| Host-DB link | `extra_hosts` commented out | uncommented (Linux needs `host-gateway`) |
| Postgres port | `-p 5432:5432` (all interfaces) | `HOST_PORT=172.17.0.1:5432` — bridge only |
| Web port | `8080:80` | `127.0.0.1:8080:80`, fronted by the host nginx |
| DB container | `docker run` with no restart policy | `--restart unless-stopped` |
| TLS / hostname | none | host nginx vhost, page at `/crashes/`, tiles at `/tiles/` |

- **Don't publish Postgres on 0.0.0.0.** Docker's port publishing writes its own
  NAT rules and is *not* filtered by `ufw`, so the script's default would expose
  the database to the internet — with `PGPASSWORD=postgres` if you didn't override
  it. Binding to the bridge address keeps it reachable from Martin and nowhere else.
- **`setup-docker.sh` has a first-boot race.** On a fresh volume the official
  Postgres entrypoint runs a *temporary* server while initializing; `pg_isready`
  passes against it, so the CSV `COPY` starts and is then killed mid-load by the
  entrypoint's shutdown ("terminating connection due to administrator command").
  It looks like an OOM and isn't. Just re-run the script once the container is up
  — the database and extension persist, and staging is recreated.
- **Set the restart policy on the DB container.** `docker-compose.yml` declares
  `restart: unless-stopped` for martin and nginx, but `setup-docker.sh` doesn't
  for Postgres, so a reboot would bring the stack back up around a dead database:
  `docker update --restart unless-stopped ar_crashes_db`.
- **Proxy with HTTP/1.1.** nginx proxies as HTTP/1.0 by default and the stack's
  `gzip` requires 1.1 (`gzip_http_version`), so a fronting vhost without
  `proxy_http_version 1.1` silently serves assets uncompressed — 803 KB of
  MapLibre instead of 214 KB. Tiles are unaffected; Martin gzips those itself.
- **Fronting an existing vhost:** if the server block uses `sub_filter`, override
  it inside the map's `location` blocks — it is inherited and will otherwise
  inject markup into this page too.
- **Small servers need swap.** The load peaks around 900 MB, which fits in 2 GB,
  but with no swap configured the aggregation step is one bad allocation away from
  the OOM killer.
- **Credentials:** the deployed `DATABASE_URL` uses the `crashes_ro` role, not the
  superuser; the generated passwords live only in `.env` (chmod 600, gitignored).

### If the map draws but no data appears

Basemap, state cutout and city outline fine; no hexes and no crash dots. Two
distinct causes produce exactly that picture, and both were hit in production:

1. **A relative URL on a source.** MapLibre loads vector tiles and URL-based
   GeoJSON sources inside a **Web Worker**, whose base URL is a `blob:`. Relative
   URLs cannot be resolved there, so every tile fails *before a request is sent* —
   `Request constructor: /tiles/hex_8km/6/15/25 is not a valid URL` — while the
   source still reports `isSourceLoaded=true` with zero features. Main-thread
   `fetch()` of the very same relative path succeeds, which is why
   `arkansas.geojson` (fetched directly) drew while the tiles and the
   worker-loaded `ar_cities.geojson` did not. **Any URL handed to a source must be
   absolute**; `index.html` and `embed.js` both absolutize against `location.href`.
   Note that the README's Option B passes an absolute `?tiles=http://…`, so this
   never shows up in local native testing — only behind the nginx `/tiles` proxy.
2. **Duplicate CORS headers.** Martin sets its own `Access-Control-Allow-Origin`
   (echoing the request's Origin) whenever the request carries one. A fronting
   nginx that *also* adds one returns **two**, which browsers reject — cross-origin
   tiles then fail with a bare `Failed to fetch` while same-origin tiles are
   perfectly fine. This is invisible to `curl` unless you pass `-H "Origin: …"`,
   since Martin stays silent without it. The vhost therefore uses
   `proxy_hide_header Access-Control-Allow-Origin` before adding its own.

`web/diagnose.html` exists for this: it prints WebGL support, raw fetch results
per endpoint, every map error, and per-source `querySourceFeatures` counts, then
renders an unfiltered bright-red probe layer — which separates "tiles never
arrived" from "tiles arrived but the filter or paint hid them". It accepts the
same `?tiles=` override as the main page.

---

## Data

- **Crashes:** Arkansas Department of Transportation (ARDOT) crash export,
  `ardot_crashes.csv` — 401,279 records, 399,812 with coordinates. Crash severity
  uses the KABCO scale (K/A/B/C/O).
- **State boundary** (`web/arkansas.geojson`): a US Census state polygon,
  simplified (`ST_SimplifyPreserveTopology`) to ~150 points for the cutout mask
  and outline.
- **City labels** (`web/ar_cities.geojson`): US Census place data — 2023
  population from the Population Estimates **SUB-EST** file joined to internal
  points from the Census **Gazetteer**, for the 500 incorporated Arkansas places.
  (Incorporated places only — no CDPs.)
