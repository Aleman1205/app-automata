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
  creada  timestamptz NOT NULL DEFAULT now()
);
-- El plan NO vive aquí: la fuente de verdad de facturación es `subscriptions`
-- (una fila por org), para no duplicar el plan en dos lugares (deriva que la
-- auditoría de docs/14 marcó como vector). Ver más abajo.

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
  -- activa = cuenta contra el stock de espacios del plan. Al bajar de plan, las
  -- sobrantes quedan activa=false (solo lectura), no se borran (docs/06 §9).
  activa  boolean NOT NULL DEFAULT true,
  -- Ciclo de vida (docs/08): ready = acepta ajustes; frozen = definitiva. 3 ajustes
  -- (cambios) incluidos; al agotarlos o congelar voluntariamente → frozen.
  ciclo_estado   text NOT NULL DEFAULT 'ready' CHECK (ciclo_estado IN ('ready','frozen')),
  ajustes_usados int  NOT NULL DEFAULT 0 CHECK (ajustes_usados >= 0 AND ajustes_usados <= 3),
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
  -- Nº de versión único por automatización (v1..v4): backstop de integridad en la BD,
  -- no solo en la disciplina de FOR UPDATE del servicio de ciclo (docs/08).
  UNIQUE (automatizacion_id, numero),
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

-- ── Billing / cuotas (M3) ──────────────────────────────────────────────────
-- Principio (corrección de la revisión adversarial de M3): el enforcement de cuota
-- NO puede depender de que el código de la app "se acuerde" de checar. RLS aísla
-- ENTRE orgs, pero NO da integridad INTRA-org: con solo RLS, automata_app podía
-- `UPDATE subscriptions SET plan='equipo'` (auto-ascenso) o `UPDATE uso_periodo SET
-- ejecuciones=0` (resetear el tope). Por eso los límites viven en la BD y se hacen
-- cumplir con triggers + una función SECURITY DEFINER; el rol de app pierde el
-- UPDATE/DELETE directo sobre estas tablas.

-- Los LÍMITES, en la BD (no solo en TS). Un test afirma que esto == PLANES (TS).
CREATE TABLE IF NOT EXISTS planes (
  plan            text PRIMARY KEY CHECK (plan IN ('base','pro','equipo')),
  espacios        int  NOT NULL,
  generaciones    int  NOT NULL,
  ejecuciones     int  NOT NULL,
  usuarios        int  NOT NULL,
  exportar_codigo boolean NOT NULL
);
INSERT INTO planes (plan, espacios, generaciones, ejecuciones, usuarios, exportar_codigo) VALUES
  ('base',   3,  6,   500,   1,  false),
  ('pro',    6,  12,  2000,  3,  false),
  ('equipo', 10, 20,  10000, 10, true)
ON CONFLICT (plan) DO UPDATE SET
  espacios = EXCLUDED.espacios, generaciones = EXCLUDED.generaciones,
  ejecuciones = EXCLUDED.ejecuciones, usuarios = EXCLUDED.usuarios,
  exportar_codigo = EXCLUDED.exportar_codigo;

-- Fuente de verdad del plan/estado de facturación de una org (una fila por org).
CREATE TABLE IF NOT EXISTS subscriptions (
  org_id              uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  plan                text NOT NULL DEFAULT 'base' REFERENCES planes(plan),
  estado              text NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa','morosa','cancelada')),
  stripe_customer_id  text,
  periodo_fin         timestamptz,
  creada              timestamptz NOT NULL DEFAULT now()
);

-- Contadores de FLUJO por mes. Solo suben, y solo vía app_consumir() (abajo).
CREATE TABLE IF NOT EXISTS uso_periodo (
  org_id        uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  periodo       text NOT NULL CHECK (periodo ~ '^[0-9]{4}-[0-9]{2}$'),
  generaciones  int  NOT NULL DEFAULT 0 CHECK (generaciones >= 0),
  ejecuciones   int  NOT NULL DEFAULT 0 CHECK (ejecuciones  >= 0),
  PRIMARY KEY (org_id, periodo)
);

-- El count de activas (bajo el trigger de cuota) es un index-scan acotado a la org.
CREATE INDEX IF NOT EXISTS idx_autom_org_activa ON automatizaciones (org_id) WHERE activa;

-- ── Kill-switch (docs/14 §3 / docs/11 §10) ─────────────────────────────────
-- Interruptores GLOBALES de incidente: congelan builds/ejecuciones "de verdad" (los
-- imponen triggers, abajo), más la palanca separada de cobros de Stripe. Fila única.
-- El rol de app NO puede escribirlos (revocado): un app comprometido no apaga el freno.
CREATE TABLE IF NOT EXISTS interruptores (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),  -- fila única
  builds       boolean NOT NULL DEFAULT false,               -- true = congelados
  ejecuciones  boolean NOT NULL DEFAULT false,
  cobros       boolean NOT NULL DEFAULT false,               -- palanca separada (Stripe)
  actualizado  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO interruptores (id) VALUES (true) ON CONFLICT DO NOTHING;

-- Suspensión por-org (freeze quirúrgico de un tenant abusivo, docs/11 §8). El app
-- tampoco puede escribirla → una org no puede des-suspenderse a sí misma.
CREATE TABLE IF NOT EXISTS suspensiones (
  org_id      uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  motivo      text,
  suspendida  timestamptz NOT NULL DEFAULT now()
);

-- Bitácora APPEND-ONLY del kill-switch (docs/14 §3): quién operó el freno y cuándo.
-- Un freno de incidente sin rastro de "quién congeló la plataforma a las 3am" es un
-- hueco de auditoría (revisión). La escriben las palancas de ops (conexión de dueño);
-- el app no la toca. reactivarOrg deja asiento aquí en vez de borrar la evidencia.
CREATE TABLE IF NOT EXISTS bitacora_kill (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor    text,                       -- quién operó (ops/dueño); null si no se pasó
  accion   text NOT NULL,              -- 'congelar' | 'descongelar' | 'suspender' | 'reactivar'
  palanca  text,                       -- 'builds' | 'ejecuciones' | 'cobros' | 'org'
  org_id   uuid,                       -- la org suspendida/reactivada (null para palancas globales)
  motivo   text,
  cuando   timestamptz NOT NULL DEFAULT now()
);

-- Dedupe de webhooks entrantes (docs/13 §4): nivel PLATAFORMA, sin org_id (no RLS).
-- La lo escribe el receptor de webhooks con la conexión de DUEÑO (corre sin usuario);
-- el rol de app no lo toca. El PK hace el dedupe atómico (INSERT ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS webhook_events (
  id        text NOT NULL,                  -- id firmado del evento (webhook-id / evt de Stripe)
  fuente    text NOT NULL CHECK (fuente IN ('cma','stripe')),
  tipo      text NOT NULL,
  recibido  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fuente, id)                   -- dedupe POR FUENTE: CMA y Stripe no colisionan
);

GRANT USAGE ON SCHEMA public TO automata_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO automata_app;
-- El rol de app NO muta su propio plan ni resetea sus contadores: solo lectura +
-- consumo vía función. El plan lo cambia el dueño/webhook de Stripe (bypassa RLS).
REVOKE INSERT, UPDATE, DELETE ON planes        FROM automata_app;
REVOKE INSERT, UPDATE, DELETE ON subscriptions FROM automata_app;
REVOKE INSERT, UPDATE, DELETE ON uso_periodo   FROM automata_app;
-- Los webhooks los procesa el rol de dueño (no el de app): dedupe + mutación de plan.
REVOKE ALL ON webhook_events FROM automata_app;
-- El kill-switch lo opera el DUEÑO/ops; el app solo lo LEE (los triggers lo consultan).
REVOKE INSERT, UPDATE, DELETE ON interruptores FROM automata_app;
REVOKE INSERT, UPDATE, DELETE ON suspensiones  FROM automata_app;
-- La bitácora del freno es append-only del dueño; el app ni la lee ni la escribe.
REVOKE ALL ON bitacora_kill FROM automata_app;

-- Org viva de la sesión, robusta: '' o no-seteada → NULL → fail-closed (0 filas).
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE AS $fn$
    SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
  $fn$;
GRANT EXECUTE ON FUNCTION app_current_org() TO automata_app;

-- ── Enforcement de cuota en la BD (M3) ──────────────────────────────────────
-- Consumo de FLUJO con tope duro. El límite se LEE de `planes` (no lo pasa el
-- llamador → no se puede inflar) y se exige subscription 'activa' (un moroso/
-- cancelado no consume). SECURITY DEFINER: corre como el dueño, así el rol de app
-- consume sin tener UPDATE directo sobre uso_periodo (no puede resetear). Lanza
-- 'CUOTA_EXCEDIDA:<recurso>:<limite>:<plan>' al tope; el TS lo traduce.
CREATE OR REPLACE FUNCTION app_consumir(p_periodo text, p_recurso text)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_org uuid := app_current_org(); v_lim int; v_plan text; v_estado text; v_val int;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'app_consumir sin contexto de org'; END IF;
  IF p_recurso NOT IN ('generaciones','ejecuciones') THEN
    RAISE EXCEPTION 'recurso de cuota inválido: %', p_recurso;
  END IF;
  SELECT s.plan, s.estado, CASE p_recurso WHEN 'generaciones' THEN p.generaciones ELSE p.ejecuciones END
    INTO v_plan, v_estado, v_lim
    FROM subscriptions s JOIN planes p ON p.plan = s.plan
    WHERE s.org_id = v_org;
  IF v_plan IS NULL THEN RAISE EXCEPTION 'org % sin subscription: consumo denegado', v_org; END IF;
  IF v_estado <> 'activa' THEN RAISE EXCEPTION 'subscription en estado %: consumo denegado', v_estado; END IF;

  INSERT INTO uso_periodo (org_id, periodo) VALUES (v_org, p_periodo)
    ON CONFLICT (org_id, periodo) DO NOTHING;
  IF p_recurso = 'generaciones' THEN
    UPDATE uso_periodo SET generaciones = generaciones + 1
      WHERE org_id = v_org AND periodo = p_periodo AND generaciones < v_lim RETURNING generaciones INTO v_val;
  ELSE
    UPDATE uso_periodo SET ejecuciones = ejecuciones + 1
      WHERE org_id = v_org AND periodo = p_periodo AND ejecuciones < v_lim RETURNING ejecuciones INTO v_val;
  END IF;
  IF v_val IS NULL THEN RAISE EXCEPTION 'CUOTA_EXCEDIDA:%:%:%', p_recurso, v_lim, v_plan; END IF;
  RETURN v_val;
END $fn$;
GRANT EXECUTE ON FUNCTION app_consumir(text, text) TO automata_app;

-- Guard del kill-switch para llamar ANTES de trabajo caro/irreversible: correr el
-- código de IA (docs/11 §10 — "ejecutar código de IA ES el producto"), abrir la
-- sesión CMA, o cobrar en Stripe. El trigger sobre el ledger (versiones/ejecuciones)
-- es el BACKSTOP; esto es el choke-point TEMPRANO. Sin él, el freno de ejecuciones
-- llegaba tarde: el run corre y RECIÉN DESPUÉS inserta en `ejecuciones` (hallazgo
-- ALTA de la revisión) — el código peligroso ya se ejecutó. SECURITY DEFINER: lee
-- interruptores/suspensiones (revocados al app) y los hace cumplir para el rol de
-- app. Fail-CLOSED (coalesce). Lanza el mismo 'SERVICIO_SUSPENDIDO:<motivo>'; el TS
-- lo traduce con comoSuspension.
CREATE OR REPLACE FUNCTION verificar_freno(p_op text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_org uuid := app_current_org(); v_congelado boolean;
BEGIN
  IF p_op NOT IN ('builds','ejecuciones','cobros') THEN
    RAISE EXCEPTION 'operación de freno inválida: %', p_op;
  END IF;
  IF v_org IS NULL THEN RAISE EXCEPTION 'verificar_freno sin contexto de org'; END IF;
  SELECT CASE p_op WHEN 'builds' THEN builds WHEN 'ejecuciones' THEN ejecuciones ELSE cobros END
    INTO v_congelado FROM interruptores;
  IF coalesce(v_congelado, true) THEN RAISE EXCEPTION 'SERVICIO_SUSPENDIDO:%', p_op; END IF;
  -- La suspensión por-org frena build/run del tenant; los cobros son palanca global.
  IF p_op <> 'cobros' AND EXISTS (SELECT 1 FROM suspensiones WHERE org_id = v_org) THEN
    RAISE EXCEPTION 'SERVICIO_SUSPENDIDO:org';
  END IF;
END $fn$;
GRANT EXECUTE ON FUNCTION verificar_freno(text) TO automata_app;

-- Trigger de STOCK (espacios activos y usuarios): hace cumplir el tope en la BD, no
-- depende de que la app llame a un helper. Advisory lock por-org (y por-recurso)
-- para serializar inserciones concurrentes (anti-TOCTOU) sin bloquear otras orgs.
CREATE OR REPLACE FUNCTION verificar_cuota_espacio() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_lim int; v_plan text; v_estado text; v_activas int;
BEGIN
  -- Solo enforza la cuota del PROPIO org en-contexto. Los inserts cross-org o sin
  -- contexto (seed como dueño) los deja a RLS (WITH CHECK), sin filtrar plan ajeno.
  IF NEW.org_id IS DISTINCT FROM app_current_org() THEN RETURN NEW; END IF;
  IF NOT NEW.activa THEN RETURN NEW; END IF;                 -- inactiva no cuenta
  IF TG_OP = 'UPDATE' AND OLD.activa THEN RETURN NEW; END IF; -- ya contaba
  PERFORM pg_advisory_xact_lock(hashtext('espacio:' || NEW.org_id::text));
  SELECT s.plan, s.estado, p.espacios INTO v_plan, v_estado, v_lim
    FROM subscriptions s JOIN planes p ON p.plan = s.plan WHERE s.org_id = NEW.org_id;
  IF v_plan IS NULL THEN RAISE EXCEPTION 'org % sin subscription: no puede activar automatización', NEW.org_id; END IF;
  IF v_estado <> 'activa' THEN RAISE EXCEPTION 'subscription en estado %: no puede activar automatización', v_estado; END IF;
  SELECT count(*) INTO v_activas FROM automatizaciones WHERE org_id = NEW.org_id AND activa;
  IF v_activas >= v_lim THEN RAISE EXCEPTION 'CUOTA_EXCEDIDA:espacios:%:%', v_lim, v_plan; END IF;
  RETURN NEW;
END $fn$;
CREATE OR REPLACE FUNCTION verificar_cuota_usuario() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_lim int; v_plan text; v_estado text; v_miembros int;
BEGIN
  IF NEW.org_id IS DISTINCT FROM app_current_org() THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('usuario:' || NEW.org_id::text));
  SELECT s.plan, s.estado, p.usuarios INTO v_plan, v_estado, v_lim
    FROM subscriptions s JOIN planes p ON p.plan = s.plan WHERE s.org_id = NEW.org_id;
  IF v_plan IS NULL THEN RAISE EXCEPTION 'org % sin subscription: no puede invitar', NEW.org_id; END IF;
  IF v_estado <> 'activa' THEN RAISE EXCEPTION 'subscription en estado %: no puede invitar', v_estado; END IF;
  SELECT count(*) INTO v_miembros FROM memberships WHERE org_id = NEW.org_id;
  IF v_miembros >= v_lim THEN RAISE EXCEPTION 'CUOTA_EXCEDIDA:usuarios:%:%', v_lim, v_plan; END IF;
  RETURN NEW;
END $fn$;

-- Kill-switch (docs/14 §3): congela la operación TG_ARGV[0] ('builds' o 'ejecuciones')
-- si el interruptor global está encendido, o si la org está suspendida. Solo enforza los
-- inserts EN-CONTEXTO de la propia org; el dueño (sin app.current_org) pasa, para poder
-- remediar durante el incidente. Lanza 'SERVICIO_SUSPENDIDO:<motivo>' (el TS lo traduce).
CREATE OR REPLACE FUNCTION verificar_kill_switch() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE v_congelado boolean; v_op text := TG_ARGV[0]; v_org uuid := app_current_org();
BEGIN
  -- Sin contexto de org: el DUEÑO/ops opera para remediar durante el incidente
  -- (bypass intencional). Pero el rol de app NUNCA corre sin contexto (conOrg lo
  -- fija siempre); si un app llega aquí con contexto NULL es bug/ataque → fail-CLOSED,
  -- no lo dejamos pasar "gratis" (defensa en profundidad; RLS ya lo bloquearía).
  IF v_org IS NULL THEN
    IF current_user = 'automata_app' THEN RAISE EXCEPTION 'SERVICIO_SUSPENDIDO:contexto'; END IF;
    RETURN NEW;
  END IF;
  -- Fila de otra org: RLS (WITH CHECK) ya la habría rechazado; el skip es defensa extra.
  IF NEW.org_id IS DISTINCT FROM v_org THEN RETURN NEW; END IF;
  IF v_op = 'builds' THEN SELECT builds INTO v_congelado FROM interruptores;
  ELSE                    SELECT ejecuciones INTO v_congelado FROM interruptores; END IF;
  -- Fail-CLOSED: si la fila única desapareció (v_congelado NULL), CONGELA, no abras.
  IF coalesce(v_congelado, true) THEN RAISE EXCEPTION 'SERVICIO_SUSPENDIDO:%', v_op; END IF;
  IF EXISTS (SELECT 1 FROM suspensiones WHERE org_id = v_org) THEN
    RAISE EXCEPTION 'SERVICIO_SUSPENDIDO:org';
  END IF;
  RETURN NEW;
END $fn$;

-- ── RLS: por org, FORZADO, con WITH CHECK (no puedes escribir en otra org) ──
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['orgs', 'memberships', 'automatizaciones', 'versiones', 'ejecuciones', 'subscriptions', 'uso_periodo'])
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
CREATE POLICY aislada_por_org ON subscriptions
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
CREATE POLICY aislada_por_org ON uso_periodo
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());

-- Triggers de cuota de STOCK (DROP+CREATE para reaplicar en cualquier versión de PG).
DROP TRIGGER IF EXISTS trg_cuota_espacio ON automatizaciones;
CREATE TRIGGER trg_cuota_espacio BEFORE INSERT OR UPDATE OF activa ON automatizaciones
  FOR EACH ROW EXECUTE FUNCTION verificar_cuota_espacio();
DROP TRIGGER IF EXISTS trg_cuota_usuario ON memberships;
CREATE TRIGGER trg_cuota_usuario BEFORE INSERT ON memberships
  FOR EACH ROW EXECUTE FUNCTION verificar_cuota_usuario();

-- Kill-switch: una versión nueva = un BUILD; una fila de ejecuciones = un RUN.
DROP TRIGGER IF EXISTS trg_kill_build ON versiones;
CREATE TRIGGER trg_kill_build BEFORE INSERT ON versiones
  FOR EACH ROW EXECUTE FUNCTION verificar_kill_switch('builds');
DROP TRIGGER IF EXISTS trg_kill_run ON ejecuciones;
CREATE TRIGGER trg_kill_run BEFORE INSERT ON ejecuciones
  FOR EACH ROW EXECUTE FUNCTION verificar_kill_switch('ejecuciones');
