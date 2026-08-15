#!/usr/bin/env bash
# ============================================================================
# load.sh — build the `crashes` database from the raw ARDOT CSV, end to end.
# Idempotent-ish: drops/recreates the crashes table. Portable to Linux/macOS.
#
#   ./db/load.sh /path/to/ardot_crashes.csv
#
# Env:
#   PGDATABASE (default: crashes), plus standard PG* vars / PGHOST / PGUSER.
# ============================================================================
set -euo pipefail

CSV="${1:?usage: load.sh /path/to/ardot_crashes.csv}"
DB="${PGDATABASE:-crashes}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo ">> creating database '$DB' (if absent) and enabling PostGIS"
createdb "$DB" 2>/dev/null || echo "   (database already exists)"
psql -d "$DB" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS postgis;"

echo ">> creating text staging table"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/01a_staging.sql"

# The ARDOT export has a CRLF header but LF data rows; PostgreSQL COPY detects
# CRLF from the header and then rejects the LF rows. Strip the lone CR while
# streaming into COPY — no 150 MB rewrite, no temp file.
echo ">> loading CSV into staging (stripping stray carriage return)"
tr -d '\r' < "$CSV" | psql -d "$DB" -v ON_ERROR_STOP=1 \
  -c "\copy crashes_staging FROM STDIN WITH (FORMAT csv, HEADER true)"

echo ">> transforming into typed 'crashes' table (booleans, geometry, indexes)"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/01b_transform.sql"

echo ">> building hex aggregates + points view"
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/02_aggregates.sql"

echo ">> done. Row/integrity check:"
psql -d "$DB" -c "SELECT count(*) crashes, count(geom) with_geom FROM crashes;"
psql -d "$DB" -c "SELECT 'hex_8km' v, sum(crash_count) FROM hex_8km
              UNION ALL SELECT 'hex_400m', sum(crash_count) FROM hex_400m;"
