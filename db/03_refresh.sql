-- ============================================================================
-- 03_refresh.sql  —  Rebuild the hex aggregates after a data reload.
--
-- The geom_5070 generated column and crash_points view update automatically,
-- so only the materialized views need refreshing.
--
--   psql -d crashes -f db/03_refresh.sql
-- ============================================================================
REFRESH MATERIALIZED VIEW hex_8km;
REFRESH MATERIALIZED VIEW hex_3km;
REFRESH MATERIALIZED VIEW hex_1km;
REFRESH MATERIALIZED VIEW hex_400m;

ANALYZE hex_8km; ANALYZE hex_3km; ANALYZE hex_1km; ANALYZE hex_400m;
