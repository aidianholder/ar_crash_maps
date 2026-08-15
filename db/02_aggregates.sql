-- ============================================================================
-- 02_aggregates.sql  —  Tiling layer for MapLibre / Martin
--
-- Depends on: the `crashes` table (public.crashes) with a geometry(Point,4326)
-- column named `geom`. Safe to re-run (idempotent). Run after every data load,
-- or use 03_refresh.sql to just refresh the materialized views.
--
--   psql -d crashes -f db/02_aggregates.sql
--
-- Each hex is emitted once per YEAR plus once as an all-years rollup (year = 0),
-- so the frontend can filter by year (and points by year) with no server-side
-- parameters. Category counts (cmv/pedestrian/impaired) are additive columns —
-- the categories overlap, so they are measures, not group-by dimensions.
-- ============================================================================

-- Equal-area projected point column for hex binning.
-- EPSG:5070 = NAD83 / Conus Albers (meters, equal-area) — correct for honest
-- density over Arkansas. STORED generated column stays in sync on reload.
ALTER TABLE crashes
  ADD COLUMN IF NOT EXISTS geom_5070 geometry(Point,5070)
  GENERATED ALWAYS AS (ST_Transform(geom, 5070)) STORED;

-- ----------------------------------------------------------------------------
-- Reusable hex binning. Assigns each crash to exactly ONE hexagon of the given
-- edge length (meters, EPSG:5070), then aggregates by (hex, year) AND by (hex)
-- via GROUPING SETS. The rollup grouping set yields a NULL year, coalesced to 0
-- = "all years". Source Year is never NULL (verified), so 0 is unambiguous.
--
-- `SET search_path` makes the function safe when inlined by CREATE MATERIALIZED
-- VIEW. ST_HexagonGrid tiles the plane from a fixed global origin, so a cell's
-- geometry is identical regardless of which point generated it — GROUP BY merges
-- points that share a hex. LIMIT 1 (nearest centre) keeps a point that lands on
-- a shared edge in a single hex, so counts stay exact.
-- ----------------------------------------------------------------------------
-- Matviews depend on this function, so drop them before redefining its signature.
DROP MATERIALIZED VIEW IF EXISTS hex_8km, hex_3km, hex_1km, hex_400m;
DROP FUNCTION IF EXISTS crash_hexbins(double precision);
CREATE OR REPLACE FUNCTION crash_hexbins(cell_size double precision)
RETURNS TABLE(
  geom           geometry(Polygon,4326),
  year           integer,
  crash_count    bigint,
  fatalities     bigint,
  injuries       bigint,
  cmv_count      bigint,
  ped_count      bigint,
  impaired_count bigint
)
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  WITH binned AS (
    SELECT c.year, c.numfatalities, c.numserinj,
           c.cmvrelated, c.nonmotoristrelated, c.impairedrelated,
           hex.geom AS hexgeom
    FROM public.crashes c
    CROSS JOIN LATERAL (
      SELECT h.geom
      FROM ST_HexagonGrid(cell_size, c.geom_5070) AS h
      WHERE ST_Intersects(c.geom_5070, h.geom)
      ORDER BY ST_Distance(ST_Centroid(h.geom), c.geom_5070)
      LIMIT 1
    ) AS hex
    WHERE c.geom_5070 IS NOT NULL
  ),
  agg AS (
    SELECT hexgeom,
           COALESCE(year, 0)                          AS year,
           count(*)::bigint                           AS crash_count,
           COALESCE(sum(numfatalities),0)::bigint     AS fatalities,
           COALESCE(sum(numserinj),0)::bigint         AS injuries,
           sum((cmvrelated)::int)::bigint             AS cmv_count,
           sum((nonmotoristrelated)::int)::bigint     AS ped_count,
           sum((impairedrelated)::int)::bigint        AS impaired_count
    FROM binned
    GROUP BY GROUPING SETS ((hexgeom, year), (hexgeom))
  )
  SELECT ST_Transform(hexgeom, 4326)::geometry(Polygon,4326) AS geom,
         year, crash_count, fatalities, injuries, cmv_count, ped_count, impaired_count
  FROM agg;
$$;

-- ----------------------------------------------------------------------------
-- Pre-aggregated hex layers, one per zoom band. Outer ::geometry(Polygon,4326)
-- cast makes the matview column carry the SRID typmod so Martin auto-discovers it.
--   edge 8 km  -> zoom <= 7   (statewide)
--   edge 3 km  -> zoom 8-9    (town / corridor)
--   edge 1 km  -> zoom 10-11  (neighborhood)
--   edge 400 m -> zoom 12     (block cluster)  -> raw points take over at 13+
-- ----------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS hex_8km, hex_3km, hex_1km, hex_400m;

CREATE MATERIALIZED VIEW hex_8km AS
  SELECT geom::geometry(Polygon,4326) AS geom, year,
         crash_count, fatalities, injuries, cmv_count, ped_count, impaired_count
  FROM crash_hexbins(8000);
CREATE MATERIALIZED VIEW hex_3km AS
  SELECT geom::geometry(Polygon,4326) AS geom, year,
         crash_count, fatalities, injuries, cmv_count, ped_count, impaired_count
  FROM crash_hexbins(3000);
CREATE MATERIALIZED VIEW hex_1km AS
  SELECT geom::geometry(Polygon,4326) AS geom, year,
         crash_count, fatalities, injuries, cmv_count, ped_count, impaired_count
  FROM crash_hexbins(1000);
CREATE MATERIALIZED VIEW hex_400m AS
  SELECT geom::geometry(Polygon,4326) AS geom, year,
         crash_count, fatalities, injuries, cmv_count, ped_count, impaired_count
  FROM crash_hexbins(400);

-- Spatial index (tile bbox lookups). Year is filtered client-side in the MVT,
-- so no DB index on year is needed — Martin ships every year bucket in the tile.
CREATE INDEX hex_8km_gix  ON hex_8km  USING gist (geom);
CREATE INDEX hex_3km_gix  ON hex_3km  USING gist (geom);
CREATE INDEX hex_1km_gix  ON hex_1km  USING gist (geom);
CREATE INDEX hex_400m_gix ON hex_400m USING gist (geom);

-- ----------------------------------------------------------------------------
-- Slim points view for high zoom. Only viz-relevant columns become tile
-- properties (keeps point tiles small); full detail lives in the base table.
-- `year` and the category flags are already here for client-side filtering.
-- ----------------------------------------------------------------------------
-- New popup-detail columns are appended so CREATE OR REPLACE stays valid.
-- crashdate is cast to text (ISO) because MVT has no date type; crashtime is
-- already text (mixed 12h/24h formats from the source, shown as-is).
CREATE OR REPLACE VIEW crash_points AS
SELECT objectid, geom, crashseverity, year, numfatalities, numserinj, county,
       speedrelated, impairedrelated, roadwaydeparturerelated, intersectionrelated,
       cmvrelated, motorcyclerelated, nonmotoristrelated,
       crashdate::text AS crashdate, crashtime, city, agencyname,
       roadwaysurfaceconidtion, lightingconditions, crashmanner
FROM crashes
WHERE geom IS NOT NULL;

ANALYZE hex_8km; ANALYZE hex_3km; ANALYZE hex_1km; ANALYZE hex_400m;
