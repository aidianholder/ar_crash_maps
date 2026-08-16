-- ============================================================================
-- 04_grants.sql  —  read-only serving role for Martin
--
-- The app only ever reads. Martin should therefore connect as an unprivileged
-- role, not as the superuser that owns the data. Idempotent; safe to re-run.
--
--   psql -d crashes -v ro_password='...' -f db/04_grants.sql
--
-- or, against the Docker container:
--
--   docker exec -i ar_crashes_db psql -v ON_ERROR_STOP=1 -U postgres -d crashes \
--     -v ro_password='...' < db/04_grants.sql
--
-- Then put the role in DATABASE_URL:
--   postgresql://crashes_ro:<password>@host.docker.internal:5432/crashes
--
-- NOTE: run this as the role that OWNS the data (the same role the loaders use,
-- i.e. `postgres`). The ALTER DEFAULT PRIVILEGES below is scoped to the granting
-- role, so it only covers objects that role creates later.
-- ============================================================================

\if :{?ro_password}
\else
  \echo 'ERROR: pass the password, e.g.  -v ro_password=''s3cret'''
  \quit 1
\endif

-- ---- 1) the role ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crashes_ro') THEN
    CREATE ROLE crashes_ro LOGIN;
  END IF;
END
$$;

ALTER ROLE crashes_ro WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  PASSWORD :'ro_password';

-- ---- 2) connect + schema ----------------------------------------------------
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO crashes_ro', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO crashes_ro;

-- ---- 3) the five published sources -----------------------------------------
-- Only what Martin publishes. The 38-column `crashes` base table is deliberately
-- NOT granted: `crash_points` is a plain view, and a view is executed with its
-- OWNER's privileges, so selecting through it needs no rights on the base table.
--
-- `GRANT SELECT ON ALL TABLES IN SCHEMA public` would NOT cover the hex_* views —
-- that form skips materialized views entirely — so they are listed explicitly.
GRANT SELECT ON hex_8km, hex_3km, hex_1km, hex_400m, crash_points TO crashes_ro;

-- ---- 4) survive a rebuild ---------------------------------------------------
-- 02_aggregates.sql DROPs and recreates the hex materialized views, which discards
-- their grants. Default privileges re-apply SELECT automatically to anything the
-- granting role creates in this schema afterwards (on PG17 this does include
-- materialized views), so a data reload does not silently break tile serving.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO crashes_ro;

-- ---- 5) report --------------------------------------------------------------
SELECT c.relname AS source,
       CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' END AS kind,
       has_table_privilege('crashes_ro', c.oid, 'SELECT') AS can_select
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('hex_8km', 'hex_3km', 'hex_1km', 'hex_400m', 'crash_points')
ORDER BY 1;
