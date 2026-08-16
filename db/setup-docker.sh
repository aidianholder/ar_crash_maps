#!/usr/bin/env bash
# ============================================================================
# setup-docker.sh — stand up PostGIS in Docker and build the `crashes` database.
#
# "Installing PostGIS" under Docker just means running the official
# postgis/postgis image (PostGIS is already baked in). This script:
#   1. launches (or reuses) a PostGIS container with a persistent volume,
#   2. waits for it to accept connections,
#   3. creates the `crashes` database and enables the PostGIS extension,
#   4. if a CSV is given, runs the full load pipeline (staging -> typed table
#      -> hex aggregates), reusing db/01a, 01b, 02.
#
# All psql runs INSIDE the container, so the host only needs Docker + bash
# (no local psql/createdb).
#
# Usage:
#   ./db/setup-docker.sh                         # provision empty DB + PostGIS
#   ./db/setup-docker.sh /path/to/ardot_crashes.csv   # provision AND load data
#
# Override defaults via environment, e.g.:
#   PGPASSWORD='s3cret' HOST_PORT=5544 ./db/setup-docker.sh data.csv
# ============================================================================
set -euo pipefail

# ---- configuration (all overridable via env) -------------------------------
CONTAINER="${CONTAINER:-ar_crashes_db}"          # container name
IMAGE="${IMAGE:-postgis/postgis:17-3.5}"          # matches the dev DB (PG17/PostGIS 3.5)
VOLUME="${VOLUME:-ar_crashes_pgdata}"             # named volume for persistence
DB="${DB:-crashes}"                               # database name
PGUSER="${PGUSER:-postgres}"                      # superuser
PGPASSWORD="${PGPASSWORD:-postgres}"              # CHANGE FOR PRODUCTION
HOST_PORT="${HOST_PORT:-5432}"                    # host port -> container 5432
CSV="${1:-}"

HERE="$(cd "$(dirname "$0")" && pwd)"

command -v docker >/dev/null 2>&1 || { echo "ERROR: docker is not installed / not on PATH." >&2; exit 1; }

# psql inside the container; pass the target database as first arg, extra psql args after.
dpsql() {
  local db="$1"; shift
  docker exec -i -e PGPASSWORD="$PGPASSWORD" "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$db" "$@"
}

# ---- 1) ensure the PostGIS container is running ----------------------------
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo ">> container '$CONTAINER' already running"
elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo ">> starting existing container '$CONTAINER'"
  docker start "$CONTAINER" >/dev/null
else
  echo ">> launching PostGIS container '$CONTAINER' ($IMAGE)"
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_USER="$PGUSER" \
    -e POSTGRES_PASSWORD="$PGPASSWORD" \
    -v "$VOLUME:/var/lib/postgresql/data" \
    -p "${HOST_PORT}:5432" \
    "$IMAGE" >/dev/null
fi

# ---- 2) wait until postgres accepts connections ----------------------------
echo -n ">> waiting for postgres to be ready"
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U "$PGUSER" >/dev/null 2>&1; then ready=1; break; fi
  echo -n "."; sleep 1
done
[ "${ready:-}" = 1 ] || { echo; echo "ERROR: postgres did not become ready in time." >&2; exit 1; }
echo " ready"

# ---- 3) create database + enable PostGIS -----------------------------------
if dpsql postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" | grep -q 1; then
  echo ">> database '$DB' already exists"
else
  echo ">> creating database '$DB'"
  dpsql postgres -c "CREATE DATABASE \"$DB\""
fi
echo ">> enabling PostGIS"
dpsql "$DB" -c "CREATE EXTENSION IF NOT EXISTS postgis;" >/dev/null

# ---- 4) optional: load the data --------------------------------------------
if [ -n "$CSV" ]; then
  [ -f "$CSV" ] || { echo "ERROR: CSV not found: $CSV" >&2; exit 1; }

  echo ">> creating text staging table (01a_staging.sql)"
  dpsql "$DB" -q < "$HERE/01a_staging.sql"

  # The ARDOT export has a CRLF header but LF data rows; PostgreSQL COPY detects
  # CRLF from the header and then rejects the LF rows. Strip the lone CR while
  # streaming into COPY inside the container (no temp file, no image mount).
  echo ">> loading $CSV into staging (stripping stray carriage return)"
  tr -d '\r' < "$CSV" | dpsql "$DB" \
    -c "\copy crashes_staging FROM STDIN WITH (FORMAT csv, HEADER true)"

  echo ">> transforming into typed 'crashes' table (01b_transform.sql)"
  dpsql "$DB" -q < "$HERE/01b_transform.sql"

  echo ">> building hex aggregates + points view (02_aggregates.sql)"
  dpsql "$DB" -q < "$HERE/02_aggregates.sql"

  echo ">> load complete. Integrity check:"
  dpsql "$DB" -c "SELECT count(*) AS crashes, count(geom) AS with_geom FROM crashes;"
  dpsql "$DB" -c "SELECT 'hex_8km' AS view, sum(crash_count) AS crashes FROM hex_8km WHERE year=0
                  UNION ALL SELECT 'hex_400m', sum(crash_count) FROM hex_400m WHERE year=0;"
else
  echo ">> no CSV given — provisioned an empty '$DB' database with PostGIS."
  echo "   Re-run with the CSV path to load it:  $0 /path/to/ardot_crashes.csv"
fi

# ---- 5) how to point Martin at this database -------------------------------
cat <<EOF

>> Done. Connection strings:
   Host tools (psql, etc.):
     postgresql://$PGUSER:$PGPASSWORD@localhost:$HOST_PORT/$DB

   Martin container (put in .env as DATABASE_URL):
     postgresql://$PGUSER:$PGPASSWORD@host.docker.internal:$HOST_PORT/$DB
   On Linux, also uncomment the 'extra_hosts: host.docker.internal:host-gateway'
   lines under the martin service in docker-compose.yml so it can resolve the host.

   Then:  docker compose up -d   &&   open http://localhost:8080
EOF
