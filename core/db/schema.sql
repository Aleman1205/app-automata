-- ─────────────────────────────────────────────────────────────────────────────
-- Schema M2: multitenancy con RLS (docs/04). La corrección crítica de docs/11 §6:
-- RLS aplica solo a un rol de aplicación NO-DUEÑO y sin BYPASSRLS, y se fuerza con
-- FORCE ROW LEVEL SECURITY en toda tabla con org_id. La app pone el org actual por
-- request con  SET LOCAL app.current_org = '<uuid>'  dentro de la transacción.
-- ─────────────────────────────────────────────────────────────────────────────

-- Rol de aplicación: NOLOGIN (se accede vía SET ROLE / connection user), NOBYPASSRLS
-- (por default los roles no lo tienen), NO es dueño de las tablas.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'automata_app') THEN
    CREATE ROLE automata_app NOLOGIN;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS orgs (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre  text NOT NULL,
  plan    text NOT NULL DEFAULT 'base',
  creada  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id  uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL,                               -- Clerk user id
  rol     text NOT NULL CHECK (rol IN ('admin', 'operador')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS automatizaciones (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  nombre  text NOT NULL,
  creada  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS versiones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automatizacion_id uuid NOT NULL REFERENCES automatizaciones(id) ON DELETE CASCADE,
  org_id            uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,  -- denormalizado para RLS
  numero            int  NOT NULL,
  estado            text NOT NULL,
  artefacto_key     text,
  creada            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ejecuciones (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL REFERENCES versiones(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  estado      text NOT NULL,
  ms          int  NOT NULL,
  costo_usd   numeric NOT NULL DEFAULT 0,
  por         text,                                    -- user_id que ejecutó
  creada      timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO automata_app;

-- ── RLS: por org, forzado, con WITH CHECK (no puedes escribir en otra org) ──
-- La clave de org viva: current_setting('app.current_org', true) (NULL si no se
-- puso → fail-closed: no ves nada).

-- Org viva de la sesión, robusta: '' o no-seteada → NULL → fail-closed (0 filas),
-- nunca un error de cast.
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
  $fn$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['orgs', 'memberships', 'automatizaciones', 'versiones', 'ejecuciones'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS aislada_por_org ON %I', t);
  END LOOP;
END $$;

-- orgs se aísla por su propia id; el resto por org_id.
CREATE POLICY aislada_por_org ON orgs
  USING (id = app_current_org())
  WITH CHECK (id = app_current_org());

CREATE POLICY aislada_por_org ON memberships
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

CREATE POLICY aislada_por_org ON automatizaciones
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

CREATE POLICY aislada_por_org ON versiones
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());

CREATE POLICY aislada_por_org ON ejecuciones
  USING (org_id = app_current_org())
  WITH CHECK (org_id = app_current_org());
