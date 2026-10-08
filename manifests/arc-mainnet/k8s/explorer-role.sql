-- The explorer's database role: reads the worker's schema, owns its own.
-- Apply once as the database owner (arckive), after the explorer's Indexer has
-- created idx_arc_explorer, then give the role a password interactively:
--   kubectl exec -i pg-explorer-0 -- psql -U arckive -d explorer < manifests/arc-mainnet/k8s/explorer-role.sql
--   kubectl exec -it pg-explorer-0 -- psql -U arckive -d explorer -c '\password explorer'
-- and put that password in the explorer's DSN Secret (explorer-app.yaml).
-- Re-running it is harmless.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'explorer') THEN
    CREATE ROLE explorer LOGIN;
  END IF;
END
$$;

-- A slow query becomes an error page, never a hung request. The rollup job
-- raises it for its own transactions (SET LOCAL).
ALTER ROLE explorer SET statement_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS explorer AUTHORIZATION explorer;

GRANT USAGE ON SCHEMA idx_arc_explorer TO explorer;
GRANT SELECT ON ALL TABLES IN SCHEMA idx_arc_explorer TO explorer;
-- Tables the worker adds later (the _insights tables when lanes start): a
-- query through a partitioned parent needs the parent's privilege only.
ALTER DEFAULT PRIVILEGES FOR ROLE arckive IN SCHEMA idx_arc_explorer GRANT SELECT ON TABLES TO explorer;
