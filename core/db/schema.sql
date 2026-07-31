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
-- NOSUPERUSER/NOBYPASSRLS NO se escriben en el DDL a propósito: son los valores por defecto de
-- CREATE ROLE, y nombrarlos —incluso para reafirmarlos— cuenta como "cambiar el atributo
-- SUPERUSER", que solo un superusuario puede hacer. En Postgres administrado (Neon, RDS) el rol
-- dueño NO es superusuario, así que la versión anterior fallaba con "permission denied to alter
-- role" al re-aplicar el esquema. En vez de pedir un privilegio que no existe ahí, se AFIRMA el
-- resultado: si el rol quedara superuser o bypassrls, RLS no aplicaría y el aislamiento entre
-- clientes sería ficción, así que se aborta ruidosamente en vez de continuar. (El arranque de la
-- app lo revisa otra vez: afirmarRolSeguro en core/src/db/pg.ts rechaza conectar con un rol así.)
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'automata_app') THEN
    CREATE ROLE automata_app LOGIN;
  ELSE
    ALTER ROLE automata_app LOGIN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'automata_app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'automata_app es SUPERUSER o BYPASSRLS: RLS no lo contendría y el aislamiento por org sería ficción. Corrígelo con un rol superusuario antes de seguir.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS orgs (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre  text NOT NULL,
  creada  timestamptz NOT NULL DEFAULT now()
);
-- El app NUNCA crea ni borra un tenant (REVOKE INSERT/DELETE ON orgs, abajo): el alta
-- y la purga son owner-only. Los hijos son ON DELETE CASCADE a propósito, para que la
-- purga owner-only (offboarding/GDPR) barra todo de una; por eso el CASCADE se conserva.
-- El plan NO vive aquí: la fuente de verdad de facturación es `subscriptions`
-- (una fila por org), para no duplicar el plan en dos lugares (deriva que la
-- auditoría de docs/14 marcó como vector). Ver más abajo.

CREATE TABLE IF NOT EXISTS memberships (
  org_id  uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  rol     text NOT NULL CHECK (rol IN ('admin', 'operador')),
  PRIMARY KEY (org_id, user_id)
);

-- Invitaciones PENDIENTES (por correo). Un admin invita a alguien que quizá todavía no tiene
-- cuenta, así que no hay user_id que guardar: el id de Clerk (user_…) sólo existe cuando la
-- persona se registra. La invitación espera aquí y se convierte en membresía en ese momento
-- (app_aceptar_invitaciones). Sin esto, invitar guardaba un user_id INVENTADO que nunca
-- coincidía con el de Clerk: la fila quedaba huérfana y a la persona se le creaba su propia
-- org en vez de unirla al equipo.
-- El correo se guarda normalizado (minúsculas, sin espacios) para que el cruce con el correo
-- verificado de Clerk sea exacto. Cuenta contra la cuota de usuarios del plan (ver
-- verificar_cuota_usuario): un lugar apalabrado ya está ocupado, o el equipo se sobrevende.
CREATE TABLE IF NOT EXISTS invitaciones (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id  uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  correo  text NOT NULL CHECK (correo = lower(btrim(correo)) AND position('@' IN correo) > 1),
  rol     text NOT NULL CHECK (rol IN ('admin', 'operador')),
  creada  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, correo)
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
  -- ENTREGA: cuándo el cliente RECIBIÓ la automatización (primera versión 'lista').
  -- Ancla la ventana de 30 días de ajustes gratis (docs/06 §4: "los ajustes durante
  -- los primeros 30 días no cuentan" — es cuando afina lo que acaba de recibir).
  -- La sella un trigger UNA sola vez; el rol de app no puede escribirla (moverla al
  -- futuro = ajustes gratis infinitos).
  entregada timestamptz,
  -- LATCH del circuit breaker de reparaciones (docs/08 §2). NULL = operando; no-NULL =
  -- enganchado (superó el cap de reparaciones) y esperando revisión humana. Es un LATCH,
  -- no un contador mensual: una vez que salta, PERSISTE entre meses hasta que ops lo
  -- rearma (limpiarRevision). Un rate-limit por mes calendario se auto-rearmaba el día 1
  -- y una automatización rota volvía a tener N builds gratis cada mes (hallazgo ALTA).
  en_revision timestamptz,
  -- CON QUÉ SE CONSTRUYÓ. Sin esto un ajuste no tiene con qué trabajar: el spec y el ejemplo
  -- vivían SOLO en build_pendiente, que el drainer BORRA al terminar, así que después del primer
  -- build la información desaparecía. Un ajuste necesita el mismo spec (para que el Verifier lo
  -- juzgue contra los mismos criterios) y el mismo ejemplo (para probar la versión nueva con los
  -- datos reales del cliente). Se escriben una vez, al crear la automatización.
  spec        jsonb,
  ejemplo_key text,
  PRIMARY KEY (id),
  UNIQUE (id, org_id)                                   -- ancla para FK compuesta
);
-- Idempotente: para BDs creadas antes de estas columnas (el CREATE TABLE de arriba
-- solo aplica en instalaciones nuevas).
ALTER TABLE automatizaciones ADD COLUMN IF NOT EXISTS entregada   timestamptz;
ALTER TABLE automatizaciones ADD COLUMN IF NOT EXISTS en_revision timestamptz;
-- El CHECK de subscriptions.estado se REDEFINE aparte: el CREATE TABLE de arriba solo aplica en
-- instalaciones nuevas, así que en una BD existente el estado 'pendiente' quedaba rechazado por el
-- constraint viejo (y el alta de todo usuario nuevo fallaba). Idempotente.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_estado_check;
ALTER TABLE subscriptions ADD  CONSTRAINT subscriptions_estado_check
  CHECK (estado IN ('pendiente', 'activa', 'morosa', 'cancelada'));

-- ARRENDAMIENTO de las colas. El claim es un UPDATE en autocommit, así que su FOR UPDATE SKIP
-- LOCKED suelta el lock ANTES del trabajo caro (planner + sesión de CMA, decenas de segundos):
-- dos corridas de cron que se solapan reclamaban LA MISMA fila y construían —y COBRABAN— el mismo
-- build dos o tres veces. Con `tomada_en` solo se reclama lo libre o lo vencido, así que un drainer
-- que muere a la mitad libera su fila solo al vencer el plazo, sin dejarla trabada para siempre.
ALTER TABLE build_pendiente  ADD COLUMN IF NOT EXISTS tomada_en timestamptz;
ALTER TABLE ajuste_pendiente ADD COLUMN IF NOT EXISTS tomada_en timestamptz;

ALTER TABLE automatizaciones ADD COLUMN IF NOT EXISTS spec        jsonb;
ALTER TABLE automatizaciones ADD COLUMN IF NOT EXISTS ejemplo_key text;

CREATE TABLE IF NOT EXISTS versiones (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  automatizacion_id uuid NOT NULL,
  org_id            uuid NOT NULL,
  numero            int  NOT NULL,
  estado            text NOT NULL,
  -- TIPO del ajuste que produjo esta versión, DERIVADO de la regresión al iniciar
  -- (docs/08 §2) y persistido aquí. Antes viajaba como parámetro hasta confirmar:
  -- el llamador podía decir 'reparacion' y saltarse el consumo entero (ALTA de la
  -- revisión). NULL = build inicial (v1), que no es un ajuste.
  tipo              text CHECK (tipo IN ('cambio','reparacion')),
  artefacto_key     text,
  -- Sesión de CMA que construye esta versión. La graba el build-start (PgStateRepo) y la
  -- USA el webhook de fin-de-build para mapear sesión→versión SIN confiar en el payload
  -- (docs/13 §4: la org se deriva por lookup del recurso firmado). UNIQUE (una sesión =
  -- una versión); nullable (builds sin sesión / seeds).
  cma_session_id    text UNIQUE,
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
ALTER TABLE versiones ADD COLUMN IF NOT EXISTS tipo text;
ALTER TABLE versiones ADD COLUMN IF NOT EXISTS cma_session_id text;
-- vista del planner (a3): se persiste al ARRANCAR el build para poder ensamblar el Artefacto
-- en la COSECHA (el webhook es thin y el run es un step aparte). El app la INSERTA (build-start)
-- pero su GRANT UPDATE sigue acotado a (estado, artefacto_key) → de-facto write-once.
ALTER TABLE versiones ADD COLUMN IF NOT EXISTS vista jsonb;
-- Idempotente de verdad: una constraint UNIQUE se respalda con un índice homónimo, así que
-- re-agregarla lanza `duplicate_table` (42P07), NO `duplicate_object` (42710) — el guard por
-- excepción no la cazaba y abortaba TODO el resto del schema. Chequear pg_constraint sí.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'versiones_cma_session_key') THEN
    ALTER TABLE versiones ADD CONSTRAINT versiones_cma_session_key UNIQUE (cma_session_id);
  END IF;
END $$;
DO $$ BEGIN
  ALTER TABLE versiones ADD CONSTRAINT versiones_tipo_chk CHECK (tipo IN ('cambio','reparacion'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS ejecuciones (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  version_id  uuid NOT NULL,
  org_id      uuid NOT NULL,
  estado      text NOT NULL,
  ms          int  NOT NULL,
  costo_usd   numeric NOT NULL DEFAULT 0,
  por         text,
  -- Clave en Storage del Resultado resuelto de esta corrida (para historial/descarga). El
  -- app ya tiene UPDATE sobre ejecuciones (no columna-scopeada), así que puede fijarla.
  resultado_key text,
  creada      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id),
  FOREIGN KEY (version_id, org_id) REFERENCES versiones (id, org_id) ON DELETE CASCADE
);
-- Idempotente: para BDs creadas antes de esta columna.
ALTER TABLE ejecuciones ADD COLUMN IF NOT EXISTS resultado_key text;

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
  exportar_codigo boolean NOT NULL,
  -- Circuit breaker de reparaciones (docs/08 §2): las reparaciones son gratis e
  -- ILIMITADAS para el cliente, pero cada una es un build real (~$1.8) y una
  -- automatización que falla en bucle es un pozo de dinero. Este NO es un límite de
  -- facturación: es un DETECTOR DE AVERÍA. Una automatización sana necesita 0-2
  -- reparaciones en su vida; >N/mes significa que está rota de verdad → se corta el
  -- auto-reparo y se escala a revisión humana (seguir tirando builds no la arregla).
  -- Por automatización y por mes. Ajustable con un UPDATE (los límites viven en la BD).
  reparaciones    int  NOT NULL DEFAULT 10
);
ALTER TABLE planes ADD COLUMN IF NOT EXISTS reparaciones int NOT NULL DEFAULT 10;
INSERT INTO planes (plan, espacios, generaciones, ejecuciones, usuarios, exportar_codigo, reparaciones) VALUES
  ('base',   3,  6,   500,   1,  false, 10),
  ('pro',    6,  12,  2000,  3,  false, 10),
  ('equipo', 10, 20,  10000, 10, true,  10)
ON CONFLICT (plan) DO UPDATE SET
  espacios = EXCLUDED.espacios, generaciones = EXCLUDED.generaciones,
  ejecuciones = EXCLUDED.ejecuciones, usuarios = EXCLUDED.usuarios,
  exportar_codigo = EXCLUDED.exportar_codigo, reparaciones = EXCLUDED.reparaciones;

-- Fuente de verdad del plan/estado de facturación de una org (una fila por org).
CREATE TABLE IF NOT EXISTS subscriptions (
  org_id              uuid PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  plan                text NOT NULL DEFAULT 'base' REFERENCES planes(plan),
  -- pendiente = dada de alta pero SIN PAGAR. Es el estado con el que nace toda org nueva: sin
  -- el, el DEFAULT 'activa' le daba a cualquiera que se registrara 3 espacios y 6 generaciones
  -- al mes = ~10 USD de builds reales de CMA, gratis y repetible con otro correo. Solo el evento
  -- de pago de Stripe lo mueve a 'activa'. app_consumir y los triggers de cuota ya exigen
  -- 'activa' para dejar gastar, asi que 'pendiente' no gasta nada sin tocar esa logica.
  estado              text NOT NULL DEFAULT 'activa' CHECK (estado IN ('pendiente','activa','morosa','cancelada')),
  stripe_customer_id  text,
  periodo_fin         timestamptz,
  -- Guard MONÓTONO anti out-of-order de Stripe: el ts (epoch) del último evento aplicado.
  -- Un evento más VIEJO (reintento/retraso) no puede regresar el estado (docs/13 §4).
  ultimo_evento_ts    bigint,
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
-- INVARIANTE (a1): org_id es NULLABLE y SIN FK a orgs A PROPÓSITO. purgarOrg (offboarding/
-- GDPR) escribe un asiento 'purgar' ANTES de borrar la org; como no hay FK, el ON DELETE
-- CASCADE no lo arrastra y la evidencia de la baja SOBREVIVE. No agregar FK aquí.
-- accion/palanca no tienen CHECK: 'purgar'/'org' entran sin migración.
CREATE TABLE IF NOT EXISTS bitacora_kill (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor    text,                       -- quién operó (ops/dueño); null si no se pasó
  accion   text NOT NULL,              -- 'congelar'|'descongelar'|'suspender'|'reactivar'|'purgar'
  palanca  text,                       -- 'builds' | 'ejecuciones' | 'cobros' | 'org'
  org_id   uuid,                       -- la org suspendida/reactivada/purgada (null = palanca global)
  motivo   text,
  cuando   timestamptz NOT NULL DEFAULT now()
);

-- Incidentes de dinero/entrega/operación (a2, auditoría de riesgo). Nivel PLATAFORMA, sin
-- RLS: ops los mira cross-org y algunos nacen SIN org (webhook desconocido pre-resolución).
-- Append-only para el app: solo INSERTA vía el SD app_registrar_incidente (REVOKE ALL abajo);
-- el dueño/ops lee y resuelve. org_id SIN FK (como bitacora_kill): un incidente sobre una org
-- purgada sobrevive como evidencia. Reemplaza los console.error que se perdían sin lector.
CREATE TABLE IF NOT EXISTS incidentes (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tipo              text NOT NULL CHECK (tipo IN ('pago_no_entregado','entrega_sin_ajuste','webhook_desconocido','build_colgado','cosecha_fallida','otro')),
  severidad         text NOT NULL DEFAULT 'media' CHECK (severidad IN ('baja','media','alta')),
  org_id            uuid,
  automatizacion_id uuid,
  version_id        uuid,
  detalle           text,
  actor             text,                    -- session_user que lo emitió (app/webhook/owner)
  cuando            timestamptz NOT NULL DEFAULT now(),
  resuelto          timestamptz,
  resuelto_por      text,
  nota              text
);
CREATE INDEX IF NOT EXISTS idx_incidentes_abiertos ON incidentes (severidad, cuando) WHERE resuelto IS NULL;

-- Outbox de cosecha (a3): el webhook thin de CMA solo ENCOLA aquí (session_id PK = dedupe);
-- un drainer (owner) hace el fetch de CMA + descarga + R2 + confirmarAjuste FUERA de la tx del
-- receptor (el I/O externo no debe colgar su tx ni el pool). Nivel plataforma (sin RLS): lo
-- inserta el webhook y lo drena el dueño. org_id viene del resolver FIRMADO (no del payload).
CREATE TABLE IF NOT EXISTS cosecha_pendiente (
  session_id  text PRIMARY KEY,
  version_id  uuid NOT NULL,
  auto_id     uuid NOT NULL,
  org_id      uuid NOT NULL,
  intentos    int  NOT NULL DEFAULT 0,
  creada      timestamptz NOT NULL DEFAULT now()
);

-- Outbox de DISPARO de build (a3-s6): el endpoint (app) encola una solicitud aprobada; un
-- drainer (owner) corre el planner (vista+contrato) y arrancarConstruccion (CMA) FUERA del
-- request. Plataforma (sin RLS): el app SOLO inserta vía el SD app_solicitar_build (que fija
-- org_id = app_current_org()); el dueño lee/borra. spec del intake, ejemplo_key en storage.
CREATE TABLE IF NOT EXISTS build_pendiente (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  nombre      text NOT NULL,
  spec        jsonb NOT NULL,
  ejemplo_key text NOT NULL,
  intentos    int  NOT NULL DEFAULT 0,
  creada      timestamptz NOT NULL DEFAULT now()
);

-- Cola de AJUSTES pedidos por el cliente. Misma disciplina que build_pendiente: el request solo
-- ENCOLA (barato, cabe en el presupuesto de una petición HTTP) y el drainer hace el trabajo caro
-- fuera —regresión, planner, sesión de CMA— porque eso tarda segundos y no puede colgar al cliente
-- ni retener una conexión de BD. `peticion` es el texto del cliente tal como lo escribió: es lo que
-- se le manda al agente, así que no se normaliza ni se resume.
-- UNIQUE parcial por automatización: dos clics del botón no encolan dos ajustes (el ciclo ya
-- rechazaría el segundo por "un build en vuelo", pero entonces el cliente vería un error en vez de
-- que simplemente no pase nada).
CREATE TABLE IF NOT EXISTS ajuste_pendiente (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL,
  automatizacion_id uuid NOT NULL REFERENCES automatizaciones(id) ON DELETE CASCADE,
  peticion          text NOT NULL,
  intentos          int  NOT NULL DEFAULT 0,
  creada            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (automatizacion_id)
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

-- ── Blindaje de search_path (hallazgo ALTA de la revisión de la ventana) ────
-- `SET search_path = public` NO basta: Postgres busca pg_temp ANTES que public para
-- RELACIONES (solo lo omite para funciones/operadores). Un `CREATE TEMP TABLE
-- automatizaciones` del rol de app hacía que las funciones SECURITY DEFINER leyeran
-- la tabla FALSA → ajustes infinitos, cuota infinita y kill-switch inerte. Se probó
-- en vivo. Doble defensa: (1) todas las funciones nombran pg_temp AL FINAL, y
-- (2) el app pierde TEMPORARY (no crea temp tables) y CREATE sobre public (no crea
-- objetos que puedan ensombrecer a los reales).
DO $$ BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM automata_app', current_database());
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM automata_app;

GRANT USAGE ON SCHEMA public TO automata_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO automata_app;
-- a1 (auditoría de riesgo): el app NUNCA crea ni borra un TENANT. RLS se lo permitiría
-- (policy `orgs` USING/WITH CHECK id = app_current_org()): podría INSERTAR su propia fila
-- o BORRARLA, y el ON DELETE CASCADE de los hijos (memberships/automatizaciones/versiones/
-- ejecuciones/subscriptions/…) arrasaría el ledger "inmutable" EVADIENDO los REVOKE DELETE
-- de abajo — el cascade de RI corre como dueño del constraint y no respeta ni privilegios
-- de tabla del invocador ni RLS. Alta y purga del tenant son owner-only (offboarding/GDPR,
-- docs/04 §4). Va DESPUÉS del GRANT de arriba, o el blanket lo re-otorga en silencio.
REVOKE DELETE ON orgs FROM automata_app;
REVOKE INSERT ON orgs FROM automata_app;
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
-- Incidentes: el app NO toca la tabla; solo emite vía el SD app_registrar_incidente (abajo).
REVOKE ALL ON incidentes FROM automata_app;
-- Outbox de cosecha: la escribe el webhook y la drena el dueño; el app no la toca.
REVOKE ALL ON cosecha_pendiente FROM automata_app;
-- Outbox de disparo de build: el app SOLO inserta vía el SD app_solicitar_build; el dueño drena.
REVOKE ALL ON build_pendiente FROM automata_app;
-- Igual que la cola de builds: solo se escribe por app_solicitar_ajuste, que valida antes de
-- encolar. Con INSERT directo el app podría saltarse esas guardas (encolar sobre una
-- automatización inactiva o con un build en vuelo) y el drainer se comería el error.
REVOKE ALL ON ajuste_pendiente FROM automata_app;
-- EL RECICLADOR (docs/06 §3, hallazgo ALTA de la revisión): el REVOKE UPDATE protege
-- la fila, pero NO su existencia — borrar y recrear reseteaba entregada, ajustes_usados
-- y ciclo_estado (ventana gratis + 3 ajustes nuevos, en bucle, con builds reales de
-- ~$52 MXN cada uno). El app no borra nunca: archivar es activa=false (docs/06 §9).
REVOKE DELETE ON automatizaciones FROM automata_app;
REVOKE DELETE ON versiones        FROM automata_app;  -- el ledger de builds no se borra
-- El app NO reescribe el ledger de versiones: solo transiciona `estado` (building→ready/
-- lista/failed) y fija `artefacto_key` al terminar el build (el pipeline lo guarda tras
-- subir el artefacto). Con UPDATE abierto podía `SET tipo='cambio'` o `SET creada=<mes
-- pasado>` para resetear el contador del circuit breaker → reparaciones gratis ilimitadas
-- (ALTA). tipo/creada/automatizacion_id/numero/org_id NO son escribibles: eso blinda el
-- contador. Mismo patrón column-scoped que automatizaciones (nombre/activa).
REVOKE UPDATE ON versiones FROM automata_app;
-- El app NO escribe cma_session_id (columna UNIQUE global): podría pre-reclamar la sesión
-- de otra org y secuestrar el despacho del webhook (hallazgo de la revisión). Lo graba el
-- build-start por un camino de confianza con el id que devuelve CMA (no elegible por el app).
GRANT  UPDATE (estado, artefacto_key) ON versiones TO automata_app;
-- a3: el INSERT sobre versiones NO estaba acotado por columna (solo UPDATE/DELETE lo estaban),
-- así que el REVOKE UPDATE(cma_session_id) protegía el post-hoc pero NO el INSERT-time: el app
-- podía pre-reclamar la sesión de otra org al insertar. Se acota el INSERT a las columnas que
-- el build-start sí escribe (cma_session_id lo fija SOLO el SD app_fijar_sesion_cma).
REVOKE INSERT ON versiones FROM automata_app;
-- Se excluye cma_session_id (pre-claim) y artefacto_key (lo fija el build via UPDATE). `creada`
-- SÍ se incluye: el trigger la normaliza a now() (anti-backdate ya probado); revocarla rompería
-- ese test sin ganar nada (el trigger igual la sobrescribe).
GRANT  INSERT (automatizacion_id, org_id, numero, estado, tipo, vista, creada) ON versiones TO automata_app;
REVOKE DELETE ON ejecuciones      FROM automata_app;  -- ni el de runs (facturación)

-- Org viva de la sesión, robusta: '' o no-seteada → NULL → fail-closed (0 filas).
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
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
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
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
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
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

-- ── Ciclo de vida: enforcement en la BD (docs/08 + ventana de docs/06 §4) ────
-- MISMO principio que la cuota: el contador de ajustes NO puede depender de que la
-- app "se acuerde". Antes `ajustes_usados` solo tenía un CHECK y el app hacía UPDATE
-- directo → podía resetearlo a 0 y regalarse ajustes (builds) INFINITOS. Ahora el
-- app no puede escribir ajustes_usados/ciclo_estado/entregada (revocados abajo);
-- solo consume por esta función, que únicamente INCREMENTA.

-- ¿La automatización está dentro de la ventana de 30 días desde la ENTREGA?
-- Fail-CLOSED: sin entrega (aún no recibe nada) o sin fila → false = el ajuste SÍ cuenta.
CREATE OR REPLACE FUNCTION en_ventana_gratis(p_auto uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT coalesce(
    (SELECT entregada IS NOT NULL AND now() < entregada + interval '30 days'
       FROM automatizaciones WHERE id = p_auto),
    false)
$fn$;
GRANT EXECUTE ON FUNCTION en_ventana_gratis(uuid) TO automata_app;

-- Consume un AJUSTE por un CAMBIO confirmado. Dentro de la ventana de 30 días NO
-- gasta ajuste (docs/06 §4) — pero el llamador SÍ consume una generación del tope
-- interno (2× espacios/mes, docs/08 §7), que es lo que acota al "ajustador infinito".
-- Fuera de la ventana: incrementa, y al llegar a MAX (3) congela (v4 es la última).
-- Devuelve el estado resultante y si el ajuste fue gratis.
-- Toma la VERSIÓN, no la automatización: el tipo (cambio/reparación) se lee de la
-- fila, donde lo dejó iniciarAjuste derivándolo de la regresión. Antes el llamador lo
-- pasaba como argumento y bastaba decir 'reparacion' para saltarse TODO el enforcement
-- (ALTA de la revisión: la protección de columnas es irrelevante si la app nunca llama
-- a la función). Ahora la BD decide si el ajuste consume.
CREATE OR REPLACE FUNCTION app_consumir_ajuste(p_version uuid)
RETURNS TABLE (estado text, usados int, gratis boolean, tipo text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_org uuid := app_current_org(); v_estado text; v_usados int; v_gratis boolean;
        v_auto uuid; v_tipo text;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'app_consumir_ajuste sin contexto de org'; END IF;
  SELECT v.automatizacion_id, v.tipo INTO v_auto, v_tipo
    FROM versiones v WHERE v.id = p_version AND v.org_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:no_existe'; END IF;

  SELECT a.ciclo_estado, a.ajustes_usados INTO v_estado, v_usados
    FROM automatizaciones a WHERE a.id = v_auto AND a.org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:no_existe'; END IF;

  -- Una REPARACIÓN es gratis e ilimitada, incluso sobre frozen (docs/08 §2: "es tu
  -- obligación, no un favor"). Solo el CAMBIO pasa por las guardas y el contador.
  IF v_tipo IS DISTINCT FROM 'cambio' THEN
    RETURN QUERY SELECT v_estado, v_usados, false, coalesce(v_tipo, 'inicial'); RETURN;
  END IF;
  IF v_estado = 'frozen' THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:frozen'; END IF;

  v_gratis := en_ventana_gratis(v_auto);
  IF NOT v_gratis THEN
    IF v_usados >= 3 THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:ajustes_agotados'; END IF;
    v_usados := v_usados + 1;
    IF v_usados >= 3 THEN v_estado := 'frozen'; END IF;   -- al tope, congela
    UPDATE automatizaciones SET ajustes_usados = v_usados, ciclo_estado = v_estado
      WHERE id = v_auto;
  END IF;
  RETURN QUERY SELECT v_estado, v_usados, v_gratis, v_tipo;
END $fn$;
GRANT EXECUTE ON FUNCTION app_consumir_ajuste(uuid) TO automata_app;

-- ── Camino de WEBHOOKS (docs/13 §4) ─────────────────────────────────────────
-- El pool de webhooks corre con un rol DEDICADO no-super (automata_webhook) sujeto a
-- FORCE RLS. Para descubrir la org (que aún no conoce) necesita LEER cross-org — imposible
-- bajo RLS sin contexto. Estos RESOLVERS son SECURITY DEFINER (dueño = quien aplica el
-- schema, que bypassa RLS), así que resuelven cross-org SIN que el rol de webhook bypasee
-- nada. Después, el handler fija app.current_org y reusa confirmarAjuste/fallarAjuste (que
-- funcionan bajo RLS con el contexto puesto). Sin esto, el handler veía 0 filas → no-op
-- permanente en prod (hallazgo ALTA de la revisión, reproducido con un dueño no-super).
CREATE OR REPLACE FUNCTION resolver_sesion_cma(p_sid text)
RETURNS TABLE (version_id uuid, auto_id uuid, org_id uuid, estado text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id, automatizacion_id, org_id, estado FROM versiones WHERE cma_session_id = p_sid
$fn$;
CREATE OR REPLACE FUNCTION resolver_org_stripe(p_cust text)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT org_id FROM subscriptions WHERE stripe_customer_id = p_cust
$fn$;

-- Vincula un customer de Stripe con una org. Es el ESLABÓN QUE FALTABA: stripe_customer_id solo lo
-- escribía un script de prueba, así que resolver_org_stripe siempre devolvía NULL y TODO evento de
-- Stripe salía por el no-op silencioso — los pagos no movían nada. El rol de webhooks tiene UPDATE
-- solo sobre (estado, ultimo_evento_ts), así que esta escritura necesita una SD.
--
-- WRITE-ONCE por customer (como cma_session_id): si el customer ya está en OTRA org, falla en vez de
-- reasignarlo. Un customer que salta de org sería una toma de control de la suscripción ajena — y un
-- reintento de webhook no debe poder provocarla. Reasignar de verdad es trabajo de ops (dueño).
-- Idempotente: si ya está vinculado a ESA org, no hace nada y devuelve true.
CREATE OR REPLACE FUNCTION app_stripe_vincular(p_org uuid, p_cust text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_dueno uuid; v_actual text;
BEGIN
  IF p_org IS NULL OR p_cust IS NULL OR length(btrim(p_cust)) = 0 THEN
    RAISE EXCEPTION 'app_stripe_vincular: org y customer requeridos';
  END IF;
  SELECT org_id INTO v_dueno FROM subscriptions WHERE stripe_customer_id = p_cust;
  IF v_dueno IS NOT NULL AND v_dueno <> p_org THEN
    RAISE EXCEPTION 'STRIPE_CUSTOMER_DE_OTRA_ORG'; -- nunca se reasigna por webhook
  END IF;
  SELECT stripe_customer_id INTO v_actual FROM subscriptions WHERE org_id = p_org;
  IF v_actual IS NOT NULL AND v_actual <> p_cust THEN
    RAISE EXCEPTION 'STRIPE_ORG_YA_TIENE_CUSTOMER'; -- la org ya paga con otro customer
  END IF;
  UPDATE subscriptions SET stripe_customer_id = p_cust
    WHERE org_id = p_org AND stripe_customer_id IS DISTINCT FROM p_cust;
  RETURN true;
END $fn$;
GRANT EXECUTE ON FUNCTION app_stripe_vincular(uuid, text) TO automata_webhook;

-- Rol del pool de webhooks: no-super, no-dueño (afirmarRolSeguro lo acepta), con los
-- privilegios MÍNIMOS para el receptor + los handlers, y sujeto a RLS (por eso necesita
-- los resolvers y app.current_org). NO puede leer cross-org por sí mismo.
-- Mismo criterio que automata_app: los atributos por defecto no se nombran (nombrarlos exige
-- superusuario y rompe en Postgres administrado) y el resultado se AFIRMA.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'automata_webhook') THEN
    CREATE ROLE automata_webhook LOGIN;
  ELSE
    ALTER ROLE automata_webhook LOGIN;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'automata_webhook' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'automata_webhook es SUPERUSER o BYPASSRLS: los handlers dejarían de estar contenidos por RLS. Corrígelo con un rol superusuario antes de seguir.';
  END IF;
END $$;

-- Privilegios MÍNIMOS del rol de webhooks (sujeto a RLS; resuelve cross-org solo por los
-- SECURITY DEFINER de arriba). Nada de GRANT ALL: lo justo para el receptor + los handlers.
GRANT USAGE ON SCHEMA public TO automata_webhook;
-- SELECT además de INSERT: el dedupe hace `INSERT … ON CONFLICT (fuente,id) DO NOTHING RETURNING id`
-- y el conflict target por sí solo exige SELECT sobre las columnas del índice árbitro. Con solo
-- INSERT, Postgres respondía "permission denied for table webhook_events" y el receptor hacía
-- ROLLBACK + throw → 500 en TODO webhook: ningún build se cosechaba y ningún pago de Stripe movía
-- nada. No se notaba porque verify-webhooks.ts conecta como superusuario, no con este rol.
GRANT INSERT, SELECT ON webhook_events TO automata_webhook;             -- dedupe (no-org, sin RLS)
-- INSERT + SELECT: el ON CONFLICT (session_id) DO NOTHING del handler necesita SELECT para
-- leer el índice árbitro (sin él: "permission denied", aunque haya INSERT). El outbox no tiene
-- secretos (ids de sesión/versión/org ya resueltos por el SD firmado); leerlo es benigno.
GRANT INSERT, SELECT ON cosecha_pendiente TO automata_webhook;
GRANT SELECT, UPDATE (estado, artefacto_key) ON versiones TO automata_webhook; -- confirmar/fallar
GRANT SELECT ON automatizaciones TO automata_webhook;                  -- estadoDelCiclo
GRANT SELECT, UPDATE (estado, ultimo_evento_ts) ON subscriptions TO automata_webhook; -- Stripe
GRANT EXECUTE ON FUNCTION app_consumir_ajuste(uuid), en_ventana_gratis(uuid),
  resolver_sesion_cma(text), resolver_org_stripe(text) TO automata_webhook;
-- Los resolvers cross-org SOLO para el rol de webhook (no el app ni PUBLIC).
REVOKE EXECUTE ON FUNCTION resolver_sesion_cma(text), resolver_org_stripe(text) FROM PUBLIC;

-- Emisión de incidentes (a2): único camino de escritura de `incidentes` para app/webhook.
-- SECURITY DEFINER (la tabla tiene REVOKE ALL). Anti-forge: si hay contexto de org, ese
-- MANDA (app bajo conOrg no puede atribuir a otra org); si no (webhook pre-resolución,
-- owner), usa el p_org que se pasa. actor = session_user (quién llamó), NO el DEFINER dueño.
CREATE OR REPLACE FUNCTION app_registrar_incidente(
  p_tipo text, p_severidad text, p_org uuid, p_auto uuid, p_version uuid, p_detalle text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  INSERT INTO incidentes (tipo, severidad, org_id, automatizacion_id, version_id, detalle, actor)
  VALUES (p_tipo, coalesce(p_severidad, 'media'), coalesce(app_current_org(), p_org), p_auto, p_version, p_detalle, session_user);
END $fn$;
GRANT EXECUTE ON FUNCTION app_registrar_incidente(text, text, uuid, uuid, uuid, text) TO automata_app, automata_webhook;

-- Fijar la sesión de CMA en la versión (a3, build-start). cma_session_id es UNIQUE global y
-- NO está en el GRANT INSERT/UPDATE del app: solo este SD la escribe, y WRITE-ONCE + org-scoped
-- + solo sobre 'building'. Así el app no puede pre-reclamar la sesión de otra org ni re-apuntarla.
CREATE OR REPLACE FUNCTION app_fijar_sesion_cma(p_version uuid, p_sid text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_org uuid := app_current_org();
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'app_fijar_sesion_cma sin contexto de org'; END IF;
  UPDATE versiones SET cma_session_id = p_sid
    WHERE id = p_version AND org_id = v_org AND estado = 'building' AND cma_session_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'SESION_CMA_NO_FIJABLE'; END IF;
END $fn$;
GRANT EXECUTE ON FUNCTION app_fijar_sesion_cma(uuid, text) TO automata_app;

-- Encolar un disparo de build (a3-s6). SECURITY DEFINER (build_pendiente tiene REVOKE ALL):
-- fija org_id = app_current_org() (el app no puede encolar para otra org). El drainer valida
-- cuota/kill-switch al crear la versión real (cobrar_build), así que esto solo registra la
-- intención; devuelve el id de la solicitud.
CREATE OR REPLACE FUNCTION app_solicitar_build(p_nombre text, p_spec jsonb, p_ejemplo_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_org uuid := app_current_org(); v_id uuid;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'app_solicitar_build sin contexto de org'; END IF;
  INSERT INTO build_pendiente (org_id, nombre, spec, ejemplo_key) VALUES (v_org, p_nombre, p_spec, p_ejemplo_key) RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;
GRANT EXECUTE ON FUNCTION app_solicitar_build(text, jsonb, text) TO automata_app;

-- Lo que el cliente YA aprobó pero todavía no tiene automatización: sigue en build_pendiente
-- porque el drainer no ha corrido. Sin esto el portafolio se ve VACÍO justo después de aprobar
-- —la automatización no existe hasta que el cron dispara— y lo más natural es que el cliente
-- crea que no se guardó y vuelva a aprobar. Eso SÍ cobra: otro build de ~$1.8 y otra generación.
-- SD porque build_pendiente tiene REVOKE ALL para el app. El guard de org_id NULL es lo que
-- impide que una sesión sin contexto se lleve la cola de TODOS los tenants.
CREATE OR REPLACE FUNCTION app_builds_en_cola()
RETURNS TABLE (id uuid, nombre text, creada timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT b.id, b.nombre, b.creada FROM build_pendiente b
   WHERE app_current_org() IS NOT NULL AND b.org_id = app_current_org()
   ORDER BY b.creada DESC;
$fn$;
GRANT EXECUTE ON FUNCTION app_builds_en_cola() TO automata_app;

-- Encola un AJUSTE. SD como app_solicitar_build (el app no escribe la cola directo). Valida aquí lo
-- que se puede saber sin correr nada, para no encolar trabajo destinado a fallar y para que el
-- cliente reciba el "no" al instante en vez de un correo de fracaso minutos después:
--   · la automatización es de SU org y está activa
--   · no hay ya un ajuste encolado ni un build en vuelo
-- Lo que NO se valida aquí es si le quedan ajustes: eso depende del TIPO, que solo se sabe al correr
-- la regresión en el drainer (una reparación se permite incluso congelada y sin ajustes).
CREATE OR REPLACE FUNCTION app_solicitar_ajuste(p_auto uuid, p_peticion text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_org uuid := app_current_org(); v_id uuid; v_activa boolean;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'app_solicitar_ajuste sin contexto de org'; END IF;
  IF p_peticion IS NULL OR length(btrim(p_peticion)) = 0 THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:peticion_vacia'; END IF;
  SELECT activa INTO v_activa FROM automatizaciones WHERE id = p_auto AND org_id = v_org;
  IF v_activa IS NULL THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:no_existe'; END IF;
  IF NOT v_activa THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:inactiva'; END IF;
  IF EXISTS (SELECT 1 FROM versiones WHERE automatizacion_id = p_auto AND estado = 'building') THEN
    RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:build_en_vuelo';
  END IF;
  INSERT INTO ajuste_pendiente (org_id, automatizacion_id, peticion)
    VALUES (v_org, p_auto, btrim(p_peticion))
    ON CONFLICT (automatizacion_id) DO NOTHING
    RETURNING id INTO v_id;
  -- Ya había uno encolado: el pedido del cliente NO se pierde ni se duplica; se devuelve el vigente.
  IF v_id IS NULL THEN SELECT id INTO v_id FROM ajuste_pendiente WHERE automatizacion_id = p_auto; END IF;
  RETURN v_id;
END $fn$;
GRANT EXECUTE ON FUNCTION app_solicitar_ajuste(uuid, text) TO automata_app;

-- ── Onboarding de un usuario nuevo (Clerk user.created / primer acceso) ──────────────────────
-- Crear un tenant es OWNER-ONLY (REVOKE INSERT ON orgs FROM automata_app): el rol de app NO puede
-- dar de alta una org directo. Estas dos SD (como resolver_sesion_cma) corren como el DUEÑO
-- (bypassa RLS) y se exponen al app/webhook con un contrato ACOTADO por user_id — el llamador solo
-- toca membresías del PROPIO usuario (el userId sale del JWT verificado, nunca del cuerpo del cliente).

-- Orgs del usuario (id + rol + nombre). Cross-org por diseño: resuelve "¿en qué org estoy?" ANTES de
-- tener contexto de org (el pipeline org-scoped no puede — chicken-and-egg). Admin primero, luego por
-- antigüedad. STABLE + SECURITY DEFINER: lee memberships/orgs saltándose RLS, filtrado por p_user.
CREATE OR REPLACE FUNCTION app_orgs_de_usuario(p_user text)
RETURNS TABLE(org_id uuid, rol text, nombre text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT m.org_id, m.rol, o.nombre
    FROM memberships m JOIN orgs o ON o.id = m.org_id
   WHERE m.user_id = p_user
   ORDER BY (m.rol = 'admin') DESC, o.creada ASC, o.id ASC
$fn$;
GRANT EXECUTE ON FUNCTION app_orgs_de_usuario(text) TO automata_app, automata_webhook;

-- Onboarding IDEMPOTENTE: si el usuario ya tiene membresía devuelve su org (sin crear nada); si no,
-- crea org + subscription (plan base) + membresía admin y devuelve la org. Un advisory lock por-usuario
-- serializa altas concurrentes (webhook user.created + primer acceso a la vez → 1 org, no 2). SD porque
-- INSERT orgs es owner-only. La cuota de usuarios NO aplica al primer admin: verificar_cuota_usuario
-- hace bypass cuando app_current_org() es NULL (que es el caso — esto corre FUERA de conOrg).
-- Convierte en membresías las invitaciones pendientes para el correo del usuario. La llama el alta
-- (webhook user.created / primer acceso) con el correo VERIFICADO de Clerk — el llamador es
-- responsable de eso: aceptar por un correo no verificado dejaría que cualquiera se cuele a un
-- equipo poniendo el correo de otro. Devuelve cuántas aceptó. Idempotente (borra la invitación al
-- convertirla) y tolerante a que ya sea miembro (ON CONFLICT DO NOTHING).
CREATE OR REPLACE FUNCTION app_aceptar_invitaciones(p_user text, p_correo text)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_correo text; v_n int := 0; v_inv record;
BEGIN
  IF p_user IS NULL OR length(trim(p_user)) = 0 THEN RAISE EXCEPTION 'app_aceptar_invitaciones: user vacío'; END IF;
  v_correo := lower(btrim(coalesce(p_correo, '')));
  IF position('@' IN v_correo) < 2 THEN RETURN 0; END IF; -- sin correo usable no hay nada que cruzar
  FOR v_inv IN SELECT id, org_id, rol FROM invitaciones WHERE correo = v_correo ORDER BY creada LOOP
    -- BORRAR ANTES DE INSERTAR: la cuota cuenta miembros + invitaciones, así que si la invitación
    -- siguiera viva al insertar la membresía, el lugar se contaría doble y el último invitado del
    -- plan no podría entrar.
    DELETE FROM invitaciones WHERE id = v_inv.id;
    INSERT INTO memberships (org_id, user_id, rol) VALUES (v_inv.org_id, p_user, v_inv.rol)
      ON CONFLICT (org_id, user_id) DO NOTHING;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $fn$;
GRANT EXECUTE ON FUNCTION app_aceptar_invitaciones(text, text) TO automata_app, automata_webhook;

-- Onboarding IDEMPOTENTE: si el usuario ya tiene membresía devuelve su org (sin crear nada); si no,
-- crea org + subscription (plan base) + membresía admin y devuelve la org. Un advisory lock por-usuario
-- serializa altas concurrentes (webhook user.created + primer acceso a la vez → 1 org, no 2). SD porque
-- INSERT orgs es owner-only. La cuota de usuarios NO aplica al primer admin: verificar_cuota_usuario
-- hace bypass cuando app_current_org() es NULL (que es el caso — esto corre FUERA de conOrg).
-- p_correo (opcional): si hay invitaciones pendientes para ese correo, el usuario ENTRA A ESE EQUIPO
-- y NO se le crea org propia. Sin esto, a un invitado se le creaba su negocio personal y la
-- invitación quedaba colgada — el equipo compartido, que es medular al producto, no funcionaba.
DROP FUNCTION IF EXISTS app_provisionar_usuario(text, text);
CREATE OR REPLACE FUNCTION app_provisionar_usuario(p_user text, p_nombre text, p_correo text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_org uuid; v_nombre text;
BEGIN
  IF p_user IS NULL OR length(trim(p_user)) = 0 THEN RAISE EXCEPTION 'app_provisionar_usuario: user vacío'; END IF;
  -- Serializa por usuario: dos altas simultáneas del MISMO user no crean dos orgs (la 2ª ve la 1ª).
  PERFORM pg_advisory_xact_lock(hashtext(p_user)::int8);
  SELECT m.org_id INTO v_org FROM memberships m
    WHERE m.user_id = p_user ORDER BY (m.rol = 'admin') DESC, org_id ASC LIMIT 1;
  IF v_org IS NOT NULL THEN RETURN v_org; END IF; -- ya pertenece a una org → idempotente
  -- ¿Lo estaban esperando en un equipo? Entonces su lugar es ese, no uno nuevo.
  IF app_aceptar_invitaciones(p_user, p_correo) > 0 THEN
    SELECT m.org_id INTO v_org FROM memberships m
      WHERE m.user_id = p_user ORDER BY (m.rol = 'admin') DESC, org_id ASC LIMIT 1;
    IF v_org IS NOT NULL THEN RETURN v_org; END IF;
  END IF;
  v_nombre := left(coalesce(nullif(trim(p_nombre), ''), 'Mi negocio'), 200);
  INSERT INTO orgs (nombre) VALUES (v_nombre) RETURNING id INTO v_org;
  -- Nace SIN PAGAR: el alta no regala builds (docs/06 decidio CONTRA la prueba gratis abierta).
  INSERT INTO subscriptions (org_id, plan, estado) VALUES (v_org, 'base', 'pendiente');
  INSERT INTO memberships (org_id, user_id, rol) VALUES (v_org, p_user, 'admin');
  RETURN v_org;
END $fn$;
GRANT EXECUTE ON FUNCTION app_provisionar_usuario(text, text, text) TO automata_app, automata_webhook;

-- Congelado VOLUNTARIO ("esta ya quedó", docs/08 §3). Va por función porque el app
-- perdió el UPDATE sobre ciclo_estado (si lo tuviera, podría des-congelarse y
-- seguir ajustando). Idempotente.
CREATE OR REPLACE FUNCTION app_congelar(p_auto uuid)
RETURNS TABLE (estado text, usados int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_org uuid := app_current_org(); v_usados int;
BEGIN
  IF v_org IS NULL THEN RAISE EXCEPTION 'app_congelar sin contexto de org'; END IF;
  -- Lock + ownership PRIMERO (esta función es SECURITY DEFINER → bypasa RLS, así que hay
  -- que scopear a mano por org). Dos motivos: (1) toma el MISMO FOR UPDATE por-fila que
  -- iniciarAjuste → serializa con él (cierra el TOCTOU del guard); (2) un p_auto AJENO
  -- devuelve no_existe UNIFORME, sin revelar si otra org tiene un build en vuelo (oracle
  -- cross-tenant).
  PERFORM 1 FROM automatizaciones WHERE id = p_auto AND org_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:no_existe'; END IF;
  -- No congelar con un CAMBIO en vuelo (de ESTA org): al confirmar vería frozen y sin el
  -- savepoint de confirmarAjuste devolvería la versión a 'building' → automatización
  -- ladrillada. Que el cliente espere a que ese build termine. Una REPARACIÓN en vuelo sí
  -- coexiste con el congelado (docs/08 §2: confirma sobre frozen sin problema).
  IF EXISTS (SELECT 1 FROM versiones v
             WHERE v.automatizacion_id = p_auto AND v.org_id = v_org
               AND v.estado = 'building' AND v.tipo = 'cambio') THEN
    RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:build_en_vuelo';
  END IF;
  -- Idempotente: si YA está frozen, el UPDATE es un no-op.
  UPDATE automatizaciones SET ciclo_estado = 'frozen' WHERE id = p_auto AND org_id = v_org
    RETURNING ajustes_usados INTO v_usados;
  RETURN QUERY SELECT 'frozen'::text, v_usados;
END $fn$;
GRANT EXECUTE ON FUNCTION app_congelar(uuid) TO automata_app;

-- Un BUILD ARRANCA cuando nace una versión: este es el ÚNICO choke-point que cruzan
-- el build inicial (v1), los ajustes y cualquier ruta futura. Cobrar aquí —y no al
-- confirmar— arregla tres agujeros ALTA verificados por la revisión:
--   · el tope era de builds TERMINADOS, no INICIADOS (docs/10 §8): 5 iniciar+fallar
--     dejaban el contador en 0 con 5 sesiones de CMA reales quemadas ("el que falla
--     mucho", docs/06 §3);
--   · el v1 no consumía NADA (crear→build→borrar→repetir: 40 builds, contador en 0,
--     −$120 USD sobre $28.5 de ingreso);
--   · el dinero se gastaba ANTES de saber si había presupuesto — al revés que el
--     patrón reserva→corre→confirma que ya usan las ejecuciones.
-- app_consumir además exige subscription 'activa', así que una org MOROSA o CANCELADA
-- deja de poder arrancar builds (otro ALTA), y el periodo lo deriva la BD (el app ya
-- no puede pasar una llave de periodo inventada para resetear su contador).
-- SECURITY DEFINER: escribe automatizaciones.en_revision (el latch) y normaliza creada,
-- cosas que el rol de app NO puede hacer directo (REVOKE UPDATE). search_path fijado con
-- pg_temp al final (no evadible por temp tables).
CREATE OR REPLACE FUNCTION cobrar_build() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_cap int; v_reps int; v_estado text; v_latch timestamptz;
BEGIN
  IF NEW.org_id IS DISTINCT FROM app_current_org() THEN RETURN NEW; END IF;  -- dueño: bypass

  -- El app puede especificar `creada` en el INSERT; la NORMALIZAMOS a now() para que no
  -- pueda backdatear una reparación fuera de la ventana y evadir el breaker (ALTA). El
  -- dueño (arriba) conserva creada libre para seeds/migraciones.
  NEW.creada := now();

  IF NEW.tipo = 'reparacion' THEN
    -- La REPARACIÓN no gasta generación: docs/08 §2 la promete "gratis e ILIMITADA, es
    -- tu obligación, no un favor". Pero el canal se acota con un CIRCUIT BREAKER: un
    -- detector de avería, no un cobro. Lock por-automatización (anti-TOCTOU, como el
    -- trigger de espacios) para serializar reparaciones concurrentes.
    PERFORM pg_advisory_xact_lock(hashtext('reparacion:' || NEW.automatizacion_id::text));

    -- (1) ¿ya enganchada? El latch PERSISTE entre meses hasta que ops la rearme: un
    --     circuit breaker no se auto-resetea con el cambio de mes (ALTA "no engancha").
    SELECT en_revision INTO v_latch FROM automatizaciones WHERE id = NEW.automatizacion_id;
    IF v_latch IS NOT NULL THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:en_revision'; END IF;

    -- (2) subscription activa: una org morosa/cancelada no dispara builds de ~$1.8
    --     (simétrico con los cambios, que pasan por app_consumir).
    SELECT s.estado, p.reparaciones INTO v_estado, v_cap
      FROM subscriptions s JOIN planes p ON p.plan = s.plan WHERE s.org_id = NEW.org_id;
    IF v_estado IS DISTINCT FROM 'activa' THEN RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:suscripcion'; END IF;
    v_cap := coalesce(v_cap, 0);

    -- (3) tasa reciente: reparaciones de ESTA automatización en los últimos 30 días
    --     (ventana RODANTE, no mes calendario → no se auto-rearma en el borde del mes ni
    --     depende de la zona horaria de la sesión). El ledger ES el contador: los builds
    --     FALLIDOS cuentan ("el que falla mucho", docs/06 §3).
    SELECT count(*) INTO v_reps FROM versiones
      WHERE automatizacion_id = NEW.automatizacion_id AND tipo = 'reparacion'
        AND creada >= now() - interval '30 days';

    IF v_reps >= v_cap THEN                    -- ya en/más allá del cap → engancha y bloquea
      UPDATE automatizaciones SET en_revision = now() WHERE id = NEW.automatizacion_id;
      RAISE EXCEPTION 'AJUSTE_NO_PERMITIDO:en_revision';
    END IF;
    IF v_reps + 1 >= v_cap THEN                -- ESTA reparación alcanza el cap → permítela y engancha
      UPDATE automatizaciones SET en_revision = now() WHERE id = NEW.automatizacion_id;
    END IF;
    RETURN NEW;
  END IF;

  -- Cambio o build inicial (tipo NULL): cobra una generación al ARRANCAR el build
  -- (app_consumir exige además subscription 'activa' → una org morosa no arranca).
  PERFORM app_consumir(to_char(now(), 'YYYY-MM'), 'generaciones');
  RETURN NEW;
END $fn$;

-- Sella la ENTREGA la PRIMERA vez que una versión queda 'lista' (el cliente ya
-- recibió algo). `entregada IS NULL` la hace once-only: ni un re-listado ni una
-- versión posterior mueven la fecha (mover = extender la ventana gratis).
CREATE OR REPLACE FUNCTION marcar_entrega() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  UPDATE automatizaciones SET entregada = now()
    WHERE id = NEW.automatizacion_id AND entregada IS NULL;
  RETURN NULL;  -- AFTER trigger
END $fn$;

-- El app no escribe el ciclo: solo `nombre` y `activa`. ajustes_usados/ciclo_estado
-- van por app_consumir_ajuste/app_congelar; `entregada` solo por el trigger.
REVOKE UPDATE ON automatizaciones FROM automata_app;
GRANT  UPDATE (nombre, activa) ON automatizaciones TO automata_app;

-- Y en el INSERT tampoco: una automatización nueva creada por el app nace siempre
-- ready/0/sin entregar. Sin esto, el app podía INSERTAR con entregada en el futuro
-- (ventana gratis eterna) o con el contador ya "gastado". El dueño (contexto NULL)
-- conserva control total: seeds, migraciones y remediación.
CREATE OR REPLACE FUNCTION normalizar_ciclo_nuevo() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.org_id IS DISTINCT FROM app_current_org() THEN RETURN NEW; END IF;
  NEW.ciclo_estado   := 'ready';
  NEW.ajustes_usados := 0;
  NEW.entregada      := NULL;
  NEW.en_revision    := NULL;   -- una automatización nueva nace sin latch de revisión
  RETURN NEW;
END $fn$;

-- Trigger de STOCK (espacios activos y usuarios): hace cumplir el tope en la BD, no
-- depende de que la app llame a un helper. Advisory lock por-org (y por-recurso)
-- para serializar inserciones concurrentes (anti-TOCTOU) sin bloquear otras orgs.
CREATE OR REPLACE FUNCTION verificar_cuota_espacio() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
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
-- Cuota de usuarios: cuenta miembros + invitaciones PENDIENTES (un lugar apalabrado ya está
-- ocupado; si no contara, invitar a 10 con 3 lugares sobrevendería el equipo). Sirve al trigger de
-- memberships y al de invitaciones — el mismo tope para los dos caminos, sin lógica duplicada.
CREATE OR REPLACE FUNCTION verificar_cuota_usuario() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_lim int; v_plan text; v_estado text; v_ocupados int;
BEGIN
  IF NEW.org_id IS DISTINCT FROM app_current_org() THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('usuario:' || NEW.org_id::text));
  SELECT s.plan, s.estado, p.usuarios INTO v_plan, v_estado, v_lim
    FROM subscriptions s JOIN planes p ON p.plan = s.plan WHERE s.org_id = NEW.org_id;
  IF v_plan IS NULL THEN RAISE EXCEPTION 'org % sin subscription: no puede invitar', NEW.org_id; END IF;
  IF v_estado <> 'activa' THEN RAISE EXCEPTION 'subscription en estado %: no puede invitar', v_estado; END IF;
  SELECT (SELECT count(*) FROM memberships  WHERE org_id = NEW.org_id)
       + (SELECT count(*) FROM invitaciones WHERE org_id = NEW.org_id) INTO v_ocupados;
  IF v_ocupados >= v_lim THEN RAISE EXCEPTION 'CUOTA_EXCEDIDA:usuarios:%:%', v_lim, v_plan; END IF;
  RETURN NEW;
END $fn$;

-- Kill-switch (docs/14 §3): congela la operación TG_ARGV[0] ('builds' o 'ejecuciones')
-- si el interruptor global está encendido, o si la org está suspendida. Solo enforza los
-- inserts EN-CONTEXTO de la propia org; el dueño (sin app.current_org) pasa, para poder
-- remediar durante el incidente. Lanza 'SERVICIO_SUSPENDIDO:<motivo>' (el TS lo traduce).
CREATE OR REPLACE FUNCTION verificar_kill_switch() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
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
  FOR t IN SELECT unnest(ARRAY['orgs', 'memberships', 'invitaciones', 'automatizaciones', 'versiones', 'ejecuciones', 'subscriptions', 'uso_periodo'])
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
CREATE POLICY aislada_por_org ON invitaciones
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
-- Mismo tope para el otro camino: invitar también ocupa lugar (si sólo se cobrara al aceptar,
-- un admin podría apalabrar 50 correos con un plan de 3 y el equipo se sobrevendería).
DROP TRIGGER IF EXISTS trg_cuota_invitacion ON invitaciones;
CREATE TRIGGER trg_cuota_invitacion BEFORE INSERT ON invitaciones
  FOR EACH ROW EXECUTE FUNCTION verificar_cuota_usuario();

-- Ciclo de vida: normaliza el ciclo al crear (app) y sella la entrega al publicar.
DROP TRIGGER IF EXISTS trg_ciclo_nuevo ON automatizaciones;
CREATE TRIGGER trg_ciclo_nuevo BEFORE INSERT ON automatizaciones
  FOR EACH ROW EXECUTE FUNCTION normalizar_ciclo_nuevo();
-- 'lista' y 'ready' son ambos "el cliente ya la puede usar": el ciclo (servicio.ts)
-- escribe 'lista'; el pipeline M0 escribe 'ready'. Se aceptan los dos a propósito —
-- si un StateRepo de Postgres usara 'ready', con solo 'lista' la entrega no se
-- sellaría NUNCA y la ventana de 30 días desaparecería en silencio.
DROP TRIGGER IF EXISTS trg_marcar_entrega ON versiones;
CREATE TRIGGER trg_marcar_entrega AFTER INSERT OR UPDATE OF estado ON versiones
  FOR EACH ROW WHEN (NEW.estado IN ('lista','ready')) EXECUTE FUNCTION marcar_entrega();

-- Kill-switch: una versión nueva = un BUILD; una fila de ejecuciones = un RUN.
DROP TRIGGER IF EXISTS trg_kill_build ON versiones;
CREATE TRIGGER trg_kill_build BEFORE INSERT ON versiones
  FOR EACH ROW EXECUTE FUNCTION verificar_kill_switch('builds');
-- Nombre a propósito: los BEFORE triggers del mismo evento corren en orden alfabético,
-- así que trg_kill_build ('k') va ANTES que trg_presupuesto_build ('p') — si el
-- servicio está congelado no se consume cuota.
DROP TRIGGER IF EXISTS trg_presupuesto_build ON versiones;
CREATE TRIGGER trg_presupuesto_build BEFORE INSERT ON versiones
  FOR EACH ROW EXECUTE FUNCTION cobrar_build();

DROP TRIGGER IF EXISTS trg_kill_run ON ejecuciones;
CREATE TRIGGER trg_kill_run BEFORE INSERT ON ejecuciones
  FOR EACH ROW EXECUTE FUNCTION verificar_kill_switch('ejecuciones');

-- Tope DURO de ejecuciones (docs/11 §8: "corta, no solo alarma"), en la BD como los
-- builds. Sin esto, el camino real del run (PgStateRepo.crearEjecucion) solo disparaba el
-- kill-switch y NADIE consumía la cuota → el tope no existía (hallazgo ALTA). app_consumir
-- exige subscription activa. Cobra al RESERVAR (antes de correr), como el build.
-- POLÍTICA (explícita): un run que reserva y luego FALLA cuenta igual (cobro al reservar,
-- sin reembolso) — simétrico con "el que falla paga" de los builds (docs/06 §3).
CREATE OR REPLACE FUNCTION cobrar_ejecucion() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.org_id IS DISTINCT FROM app_current_org() THEN RETURN NEW; END IF;  -- dueño: bypass
  PERFORM app_consumir(to_char(now(), 'YYYY-MM'), 'ejecuciones');
  RETURN NEW;
END $fn$;
-- 'kill_run' ('k') corre ANTES que 'presupuesto_run' ('p'): si está congelado, no cobra.
DROP TRIGGER IF EXISTS trg_presupuesto_run ON ejecuciones;
CREATE TRIGGER trg_presupuesto_run BEFORE INSERT ON ejecuciones
  FOR EACH ROW EXECUTE FUNCTION cobrar_ejecucion();
