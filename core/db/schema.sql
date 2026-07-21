-- ─────────────────────────────────────────────────────────────────────────────
-- Schema M2: multitenancy con RLS (docs/04). La corrección crítica de docs/11 §6:
-- la app se conecta con un rol DEDICADO, NO-DUEÑO, NOSUPERUSER, NOBYPASSRLS —
-- así RLS aplica a TODA query, no solo a las envueltas en conOrg. Se fuerza con
-- FORCE ROW LEVEL SECURITY. La org viva se pone por request con app.current_org.
--
-- La migración/semilla la corre el DUEÑO/superusuario (RLS lo bypassa, correcto);
-- la app corre como automata_app (RLS aplica, fail-closed sin contexto).
-- ─────────────────────────────────────────────────────────────────────────────

-- Rol de aplicación: LOGIN (la app conecta como él), NOSUPERUSER, NOBYPASSRLS,
-- NO dueño de las tablas. El password se fija fuera de banda (secreto); en local
-- con --auth=trust conecta sin password.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'automata_app') THEN
    CREATE ROLE automata_app LOGIN NOSUPERUSER NOBYPASSRLS;
  ELSE
    ALTER ROLE automata_app LOGIN NOSUPERUSER NOBYPASSRLS;
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
  user_id text NOT NULL,
  rol     text NOT NULL CHECK (rol IN ('admin', 'operador')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS automatizaciones (
  id      uuid NOT NULL DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  nombre  text NOT NULL,
  creada  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, org_id)                                   -- ancla para FK compuesta
);

CREATE TABLE IF NOT EXISTS versiones (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  automatizacion_id uuid NOT NULL,
  org_id            uuid NOT NULL,
  numero            int  NOT NULL,
  estado            text NOT NULL,
  artefacto_key     text,
  creada            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  UNIQUE (id, org_id),
  -- FK COMPUESTA: el org_id denormalizado DEBE ser el de la automatización padre.
  -- Sin esto, conOrg(A) podía colgar una versión org_id=A de la automatización de B.
  FOREIGN KEY (automatizacion_id, org_id) REFERENCES automatizaciones (id, org_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ejecuciones (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL,
  org_id      uuid NOT NULL,
  estado      text NOT NULL,
  ms          int  NOT NULL,
  costo_usd   numeric NOT NULL DEFAULT 0,
  por         text,
  creada      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (version_id, org_id) REFERENCES versiones (id, org_id) ON DELETE CASCADE
);

GRANT USAGE ON SCHEMA public TO automata_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO automata_app;

-- Org viva de la sesión, robusta: '' o no-seteada → NULL → fail-closed (0 filas).
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
  $fn$;
GRANT EXECUTE ON FUNCTION app_current_org() TO automata_app;

-- ── RLS: por org, FORZADO, con WITH CHECK (no puedes escribir en otra org) ──
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

CREATE POLICY aislada_por_org ON orgs
  USING (id = app_current_org()) WITH CHECK (id = app_current_org());
CREATE POLICY aislada_por_org ON memberships
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
CREATE POLICY aislada_por_org ON automatizaciones
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
CREATE POLICY aislada_por_org ON versiones
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
CREATE POLICY aislada_por_org ON ejecuciones
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
