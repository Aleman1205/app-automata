# 15 — El motor implementado (catálogo maestro)

> **Qué es este doc.** El mapa del **motor real** que se construyó en la Fase 1.
> Los docs 01–14 son *diseño*; este es el *inventario de lo que existe en código*,
> con `archivo:línea` para cada afirmación y el script de `verify` que lo prueba.
> Cuando el diseño y el código difieren, **manda el código** y se anota aquí.
>
> Todo el código del motor vive en **`core/`** (TypeScript + tsx, framework-agnóstico)
> y se cablea a Next 16 desde **`web/lib/automata/wiring.ts`** + `web/app/api/**`.
> El front (`web/` fuera de `lib/automata` y `app/api`) sigue siendo el prototipo demo.

## Estado de implementación (2026-07-26)

Lo de este catálogo **ya está construido y probado**, no es plan:

- **Motor `core/`**: ~43 módulos TS bajo `core/src/**` + el schema de BD en
  `core/db/schema.sql` (**852 líneas**, idempotente). Framework-agnóstico; `web/`
  solo lo envuelve.
- **Suite de verificación**: **28 scripts** `verify:*` en `core/package.json:28-55`
  (28 archivos `core/scripts/verify-*.ts`), más `typecheck` y el `next build` del front.
  De los 28, **15 corren contra un Postgres real** (los `*:pg` + `verify:http`) y **13
  son "gratis"** (lógica pura, sin BD ni credenciales). El Postgres de pruebas se
  levanta temporal (p.ej. puerto 55432).
- **Lo que NO existe todavía**: las **credenciales/infra de producción** (Clerk, Neon,
  Upstash, R2, Stripe, CMA, crons de Vercel) y el **runner gVisor desplegado**. El código
  para todo eso está cableado; falta encender las llaves. Ver el
  [checklist para activar](#8-checklist-para-activar-en-producción).

> **Nota sobre la cifra "22".** Rondas previas hablaban de ~22 scripts de verify;
> el conteo real hoy es **28** (`grep -c '"verify' core/package.json` = 28,
> `ls core/scripts/verify-*.ts | wc -l` = 28).

---

## 1. Mapa de módulos `core/`

Cada fila: qué hace el módulo y qué `verify` lo cubre. Rutas relativas a `core/`.

### Base de datos y aislamiento

| Módulo | Qué hace | Verify |
|---|---|---|
| `db/schema.sql` | Todo el enforcement de la BD: roles, RLS, funciones `SECURITY DEFINER`, triggers, tablas. Idempotente (`src/db/pg.ts` no lo aplica; lo corre el dueño). | `verify:pg`, `verify:cuota:pg`, … (todos los `*:pg`) |
| `db/test-aislamiento.sql` | Prueba SQL pura del aislamiento RLS (12 casos), corre como `automata_app` con psql. | Script psql aparte (no lo invoca `verify:pg`; `verify:pg` re-implementa los mismos checks por el camino de código Node→pg→RLS) |
| `src/db/pg.ts` | `crearPool` / `crearPoolApp` (afirma rol seguro al abrir), `afirmarRolSeguro` (rechaza super/BYPASSRLS/**dueño de tablas**), `conOrg` (BEGIN + `SET LOCAL ROLE automata_app` + `set_config app.current_org`). | `verify:pg` |
| `src/state/pg.ts` | `PgStateRepo`: el `StateRepo` contra Postgres — cada método corre por `conOrg`, así que dispara los triggers (cuota, kill-switch, entrega). `fijarSesionCma` va por el SD write-once. | `verify:pgstate:pg` |
| `src/state/memory.ts` | `MemoryStateRepo` (el mismo puerto, en RAM) — para M0 y tests gratis. | `verify` (run-vista) |

### Pipeline HTTP y autorización

| Módulo | Qué hace | Verify |
|---|---|---|
| `src/http/pipeline.ts` | `autorizar()` + `withEfecto()`: **las 8 capas** (`pipeline.ts:51-104`), fail-closed. Traduce `NoAutorizado→403`, `CuotaExcedida→402`, `ServicioSuspendido→503`. | `verify:http` |
| `src/http/adaptador.ts` | `adaptar()` (Request→Solicitud→Response, sin fugas; 500 genérico) y `adaptarUpload()` (cuerpo binario por las mismas 8 capas). | `verify:adaptador:pg` |
| `src/http/endpoints.ts` | Los `Endpoint` reales: `crearAutomatizacionEP`, `invitarEP`, `quitarMiembroEP`, `ejecutarEP`, `solicitarBuildEP`. | `verify:http`, `verify:rutas` |
| `src/http/tipos.ts` | `Solicitud`/`Respuesta`/`R` (helpers de status), puertos `Sesion`/`RateLimiter`. | (transversal) |
| `src/auth/roles.ts` | `assertCan` (rol por acción, `Record` exhaustivo), `necesitaStepUp` (step-up MFA). 2 roles: `admin`/`operador`. | `verify:auth` |
| `src/auth/membresia.ts` | `leerMembresia`: el rol **vivo** por request (expulsar pega al siguiente request). | `verify:http` |

### Ciclo de vida, cuota y ops

| Módulo | Qué hace | Verify |
|---|---|---|
| `src/ciclo/servicio.ts` | `iniciarAjuste` (tipo derivado de la regresión), `confirmarAjuste` (entrega garantizada con SAVEPOINT), `fallarAjuste`, `congelar`, `reaparBuildsColgados`, `automatizacionesEnRevision`/`limpiarRevision`. | `verify:ciclo:pg`, `verify:ventana:pg`, `verify:reparaciones:pg` |
| `src/ciclo/estados.ts` | Máquina de estados pura: `clasificar` (cambio/reparación), `puedeAjustar`, `ajustesRestantes`. | `verify:ciclo` |
| `src/billing/cuota.ts` | `crearAutomatizacion`/`invitarMiembro`, `comoCuota` (traduce `CUOTA_EXCEDIDA`), `CuotaExcedida`. | `verify:cuota`, `verify:cuota:pg` |
| `src/billing/plan.ts` / `planes.ts` | Cambio de plan/downgrade (excedente `activa=false` solo lectura) y la tabla `PLANES` (== tabla `planes` de la BD). | `verify:plan:pg`, `verify:cuota` |
| `src/ops/killswitch.ts` | `verificarFreno`/`exigirCobrosActivos` (guard temprano), palancas de ops (`congelar`/`suspenderOrg`/…) con bitácora, `purgarOrg` (baja de tenant owner-only). | `verify:killswitch:pg`, `verify:offboarding:pg` |
| `src/ops/incidentes.ts` | `registrarIncidente` (SD) y `emitirEnTx` (SAVEPOINT anti re-brick); `incidentesAbiertos`/`resolverIncidente` para ops. | `verify:incidentes:pg` |

### Data plane: build, run, storage, entrada

| Módulo | Qué hace | Verify |
|---|---|---|
| `src/cma/build.ts` | `CmaBuildClient`: `build()` síncrono (M0) + `arrancar()`/`cosechar()` async (producción) + `clasificarSesion()` (desenlace real por `outcome_evaluations`). Environment blindado: deps pre-horneadas + `networking:limited` sin hosts. | `verify:cma` |
| `src/run/executor.ts` | `LocalPythonExecutor` (a5-Fase 0): env allowlist anti-fuga de secretos, `ulimit -t/-f`, kill de grupo, lectura acotada. Guard anti-prod. | `verify:sandbox` |
| `src/run/container-executor.ts` | `ContainerRunExecutor` (a5-Fase 2): jaula gVisor (`--runtime=runsc --network none --read-only --user 65534 --cap-drop ALL --pids-limit --memory --cpus`). | (se prueba al desplegar el runner) |
| `src/storage/r2.ts` | `R2Storage` (S3-compat, cliente inyectable, `list` pagina, `existe()` para el guard de bytes). | `verify:storage` |
| `src/storage/local.ts` | `LocalStorage` (FS local) — mismo puerto `Storage`, para M0. | `verify` (run-vista) |
| `src/entrada/validador.ts` | `validarArchivo`/`validarLote`: gate determinista (XXE, zip-bomb, pixel-flood, spoofing, sobre agregado). | `verify:entrada` |
| `src/entrada/deteccion.ts` | Magic bytes, inspección de ZIP, escaneo XXE, dimensiones de imagen. | `verify:entrada` |
| `src/entrada/puente.ts` | El **choke-point** `gatearEjemplo`/`gatearInputs`/`gatearArchivoBytes`, cableado a build/run/upload. | `verify:entrada:gate` |

### Pipeline de build y loop asíncrono

| Módulo | Qué hace | Verify |
|---|---|---|
| `src/pipeline/build-pipeline.ts` | `construir` (M0 síncrono, con compensación), `arrancarConstruccion` (build-start async: reserva + arranca + fija sesión), `ejecutar` (reserva→corre→confirma). | `verify:pgstate:pg`, `verify:entrada:gate` |
| `src/pipeline/disparo.ts` | `drenarBuilds`: drena `build_pendiente` → planner → `arrancarConstruccion` (fuera del request, pool dueño, `FOR UPDATE SKIP LOCKED`). | `verify:disparo:pg` |
| `src/pipeline/cosecha.ts` | `cosecharYConfirmar`/`drenarCosecha`: drena `cosecha_pendiente` → re-consulta CMA → sube a R2 → guard de bytes con `existe()` → confirma. Idempotente. | `verify:cosecha:pg` |
| `src/vista/resolver.ts` | `resolverVista`: aterriza `vista.json` (refs `@resultado.*`) sobre los datos del run → `Resultado` (contrato de docs/09). | `verify` (run-vista) |

### Webhooks

| Módulo | Qué hace | Verify |
|---|---|---|
| `src/webhooks/firma.ts` | `verificarStandardWebhook` (CMA/Svix) y `verificarStripe`: HMAC-SHA256 sobre el cuerpo **crudo**, `timingSafeEqual`, ventana ±5 min. | `verify:webhooks` |
| `src/webhooks/receptor.ts` | `recibir`: firma → parse → extrae **solo el recurso firmado** → dedupe + despacho **atómicos** (`webhook_events`, at-least-once). | `verify:webhooks` |
| `src/webhooks/handlers.ts` | `procesarCma` (encola cosecha / falla in-tx; `data.type` reales) y `procesarStripe` (guard monótono anti out-of-order). Resuelven la org por SD cross-org. | `verify:webhooks:handlers:pg` |

### Agentes reales (intake + planner)

| Módulo | Qué hace | Verify |
|---|---|---|
| `src/intake/*` | El entrevistador (`agent.ts`, `prompt.ts`, `schema.ts`, `validator.ts`, `adapter.ts`): opción múltiple → spec validado. | `verify:intake` |
| `src/planner/*` | `PlannerAgent` (`agent.ts`, `prompt.ts`, `schema.ts`) + `coherencia.ts` (puerta vista↔contrato). | `verify:planner` |

---

## 2. El modelo de seguridad en la BD

La corrección central de docs/11 §6 y docs/04: **el enforcement no depende de que la app
"se acuerde" de checar**. Vive en la BD (roles + RLS + SD + triggers), y el rol de app
pierde los privilegios directos que le permitirían evadirlo.

### 2.1 Tres roles (`schema.sql`)

| Rol | Definición | Para qué | Línea |
|---|---|---|---|
| `automata_app` | `LOGIN NOSUPERUSER NOBYPASSRLS`, **no dueño** | Todas las rutas de request (`conOrg`). Sujeto a RLS. | `schema.sql:14-20` |
| `automata_webhook` | `LOGIN NOSUPERUSER NOBYPASSRLS`, **no dueño** | El receptor de webhooks: resuelve la org cross-org **solo** por los SD firmados y luego opera bajo RLS. | `schema.sql:514-520` |
| dueño (owner) | superusuario/dueño de las tablas | Migraciones (aplica el schema) + crons de ops (reaper/cosecha/disparo, barrido cross-org). **Nunca** una ruta de request. | (URL `DATABASE_URL_OWNER`) |

`afirmarRolSeguro` (`src/db/pg.ts:41-69`) **rechaza arrancar** si el rol de la app es
superusuario, tiene BYPASSRLS, **o es dueño de alguna tabla de `public`** (podría
`DISABLE ROW LEVEL SECURITY`). `crearPoolApp` lo llama al abrir el pool.

### 2.2 RLS: `FORCE`, por org, con `WITH CHECK`

7 tablas con RLS habilitado **y forzado** (`schema.sql:774-798`): `orgs`, `memberships`,
`automatizaciones`, `versiones`, `ejecuciones`, `subscriptions`, `uso_periodo`. Una sola
política por tabla, `aislada_por_org`: `USING (org_id = app_current_org()) WITH CHECK (…)`.
Sin `app.current_org` puesto, `app_current_org()` devuelve NULL → **0 filas** (fail-closed,
`schema.sql:363-366`).

Los grants son **column-scoped**: el app solo puede escribir lo que le toca. Ejemplos:
- `automatizaciones`: `GRANT UPDATE (nombre, activa)` (`schema.sql:695`) — no `ciclo_estado`,
  `ajustes_usados`, `entregada`, `en_revision`.
- `versiones`: `GRANT INSERT (automatizacion_id, org_id, numero, estado, tipo, vista, creada)`
  y `GRANT UPDATE (estado, artefacto_key)` (`schema.sql:350,359`) — **no** `cma_session_id`
  (anti pre-claim cross-org) ni `tipo`/`creada` post-hoc (blinda el contador del breaker).
- `REVOKE DELETE` sobre `orgs`/`automatizaciones`/`versiones`/`ejecuciones` — el app **nunca
  borra** (borrar+recrear reseteaba `entregada` y el contador → builds gratis; `schema.sql:314-360`).
- El app pierde `TEMPORARY` y `CREATE` sobre `public` (`schema.sql:298-303`): blindaje de
  `search_path` — sin esto un `CREATE TEMP TABLE automatizaciones` engañaba a los SD.

### 2.3 Funciones `SECURITY DEFINER` (el único camino a lo revocado)

| Función | Qué hace | Línea |
|---|---|---|
| `app_current_org()` | Org viva de la sesión; `''`/no-seteada → NULL (fail-closed). | `363` |
| `app_consumir(periodo, recurso)` | Consumo de flujo con tope duro; exige subscription `activa`; el límite se **lee** de `planes`. | `375` |
| `verificar_freno(op)` | Guard temprano del kill-switch (antes del trabajo caro). Fail-closed. | `413` |
| `en_ventana_gratis(auto)` | ¿Dentro de los 30 días desde la entrega? Fail-closed sin entrega. | `440` |
| `app_consumir_ajuste(version)` | Consume el ajuste **según el tipo persistido** en la versión; reparación = gratis; al tope congela. | `459` |
| `resolver_sesion_cma(sid)` | Sesión CMA firmada → versión/auto/org (cross-org, solo rol webhook). | `501` |
| `resolver_org_stripe(cust)` | `stripe_customer_id` → org (cross-org, solo rol webhook). | `506` |
| `app_registrar_incidente(...)` | Único INSERT de `incidentes`; anti-forge (contexto de org manda); `actor = session_user`. | `542` |
| `app_fijar_sesion_cma(version, sid)` | Fija `cma_session_id` **write-once**, org-scoped, solo sobre `building`. | `554` |
| `app_solicitar_build(nombre, spec, key)` | Encola en `build_pendiente` fijando `org_id = app_current_org()`. | `569` |
| `app_congelar(auto)` | Congelado voluntario; no congela con un cambio en vuelo (anti-brick). | `582` |

### 2.4 Triggers (backstop sobre el ledger)

| Trigger | Tabla / evento | Función | Línea |
|---|---|---|---|
| `trg_cuota_espacio` | `automatizaciones` INSERT/UPDATE(activa) | `verificar_cuota_espacio` (advisory lock) | `801-803` |
| `trg_cuota_usuario` | `memberships` INSERT | `verificar_cuota_usuario` (advisory lock) | `804-806` |
| `trg_ciclo_nuevo` | `automatizaciones` INSERT | `normalizar_ciclo_nuevo` (nace ready/0/sin entrega) | `809-811` |
| `trg_marcar_entrega` | `versiones` INSERT/UPDATE(estado) cuando `lista`/`ready` | `marcar_entrega` (sella la entrega una vez) | `816-818` |
| `trg_kill_build` | `versiones` INSERT | `verificar_kill_switch('builds')` | `821-823` |
| `trg_presupuesto_build` | `versiones` INSERT | `cobrar_build` (**cobra la generación al ARRANCAR**; circuit breaker de reparaciones) | `827-829` |
| `trg_kill_run` | `ejecuciones` INSERT | `verificar_kill_switch('ejecuciones')` | `831-833` |
| `trg_presupuesto_run` | `ejecuciones` INSERT | `cobrar_ejecucion` (cobra al reservar) | `849-851` |

Detalle clave: los `trg_kill_*` (`k`) corren **antes** que los `trg_presupuesto_*` (`p`) por
orden alfabético — si el servicio está congelado, no se cobra cuota (`schema.sql:824-826,848`).
`cobrar_build` cobra al **arrancar** el build, no al confirmarlo: cierra tres agujeros ALTA
(el que falla no salía gratis, el v1 sí consume, y se cobra tras confirmar presupuesto;
`schema.sql:611-679`).

---

## 3. El loop de build de punta a punta (asíncrono)

El build de producción **no espera** dentro del request. La secuencia real:

```
Cliente
  │  POST /api/orgs/:orgId/ejemplo   (multipart, campo 'archivo')
  ▼
subirEjemplo (wiring.ts:216-245)
  · 8 capas (adaptarUpload) → gate de entrada (gatearArchivoBytes) ANTES de guardar
  · put a R2 en ejemplos/<org>/<uuid>.<ext>  →  devuelve { ejemploKey }
  │
  │  POST /api/orgs/:orgId/construir  { nombre, spec, ejemploKey }
  ▼
solicitarBuildEP (endpoints.ts:131-143)
  · valida que ejemploKey esté bajo ejemplos/<org>/  →  app_solicitar_build()
  · encola en build_pendiente (SD fija org_id)        →  201 { id }
  │
  │  cron/disparo cada 2 min (vercel.json)  →  cronDisparo → drenarBuilds
  ▼
drenarBuilds (pipeline/disparo.ts:31-77)   [pool DUEÑO, FOR UPDATE SKIP LOCKED]
  1. planner.planear(spec)               → vista + resultado_contrato
  2. baja el ejemplo de R2 a un temp
  3. arrancarConstruccion (build-pipeline.ts:88-110):
       gate → crearAutomatizacion (cobra espacio) → crearVersion 'building'
       (cobrar_build cobra la generación) → cosechador.arrancar() (abre sesión CMA)
       → fijarSesionCma (write-once)
  │
  ▼  (CMA construye ~10 min; el webhook es THIN)
POST /api/webhooks/cma   (firma standard-webhooks sobre cuerpo CRUDO)
  ▼
recibir (webhooks/receptor.ts) → procesarCma (webhooks/handlers.ts:35-75)
  · resolver_sesion_cma(sid) [SD cross-org] → versión/org
  · data.type == session.status_idled     → INSERT en cosecha_pendiente (outbox)
  · data.type == session.status_terminated → fallarAjuste in-tx
  │
  │  cron/cosecha cada 2 min  →  cronCosecha → drenarCosecha
  ▼
drenarCosecha / cosecharYConfirmar (pipeline/cosecha.ts)   [pool DUEÑO]
  · cosechador.cosechar(sid): RE-CONSULTA la sesión (clasificarSesion) → desenlace REAL
  · satisfecho → ensambla Artefacto (código + vista persistida) → put a R2
                 → GUARD de bytes (storage.existe) → confirmarAjuste (building→'lista')
  · fallido → fallarAjuste ;  en_curso/sin_bytes → se deja para reintento
  ▼
La automatización queda 'lista'. El reaper (cron cada 10 min) es el backstop.
```

**Hallazgo importante sobre el webhook de CMA** (corrige suposiciones previas de docs/13):
el webhook es **THIN** — sus `data.type` reales son `session.status_idled`,
`session.status_terminated` y `session.outcome_evaluation_ended`
(`webhooks/handlers.ts:20-22`, `cma/build.ts:31-35`). **Ninguno dice si el build pasó**:
el éxito solo se sabe **re-consultando la sesión** (`outcome_evaluations[].result === "satisfied"`,
`cma/build.ts:130-146`). Por eso la decisión de éxito vive en `cosechar()`/`clasificarSesion()`,
no en el handler. Nombres como `session.completed`/`build.completed` que se dieron por buenos
en rondas anteriores **no existen**.

El **camino M0 síncrono** (`build-pipeline.ts:35-82` + `cma/build.ts:build()`) sigue existiendo
para `npm run m0` y pruebas locales; gasta dinero y no va en la ruta HTTP.

---

## 4. La suite de verificación (28 scripts)

Comando: `cd core && npm run <script>`. Los `*:pg` (y `verify:http`) necesitan un Postgres
levantado con el schema aplicado por el rol dueño; los demás corren sin BD ni credenciales.

| Script (`npm run …`) | Archivo | Qué prueba |
|---|---|---|
| `verify` | `verify-run-vista.ts` | M0 gratis: mitad run → resolver-vista, reusando el artefacto del spike (sin modelo). |
| `verify:intake` | `verify-intake.ts` | Núcleo determinista del intake (validador de spec + adaptador a M0), sin modelo. |
| `verify:planner` | `verify-planner.ts` | Núcleo determinista del planner: puerta de coherencia vista↔contrato. |
| `verify:auth` | `verify-auth.ts` | Capa de rol (`assertCan`): elevación intra-org y cross-org, sin DB. |
| `verify:cuota` | `verify-cuota.ts` | Contrato de planes: valores, regla 2× (generaciones = 2× espacios), fail-closed. |
| `verify:entrada` | `verify-entrada.ts` | Gate de insumos con fixtures hostiles (ZIP con DEFLATE real, XXE, pixel-flood…). |
| `verify:entrada:gate` | `verify-entrada-gate.ts` | Que `construir()`/`ejecutar()` **invocan** el gate y cortan antes de todo efecto. |
| `verify:http` | `verify-http.ts` | Las 8 capas end-to-end contra Postgres real, IDOR cross-org, fail-closed. |
| `verify:webhooks` | `verify-webhooks.ts` | Firma de webhooks (KAT oficial de standard-webhooks) + receptor (dedupe atómico). |
| `verify:ciclo` | `verify-ciclo.ts` | Máquina de estados del ciclo (clasificación, guardas, transiciones, congelado). |
| `verify:ciclo:pg` | `verify-ciclo-pg.ts` | Ciclo en Postgres: reserva→confirma, tipo derivado, consumo al llegar a `ready`. |
| `verify:plan:pg` | `verify-plan-pg.ts` | Downgrade: excedente `activa=false` atómico; reactivación sin oversell. |
| `verify:killswitch:pg` | `verify-killswitch-pg.ts` | Kill-switch: congela builds/ejecuciones de verdad; el app no lo apaga ni evade. |
| `verify:offboarding:pg` | `verify-offboarding-pg.ts` | `purgarOrg`: CASCADE arrasa hijos, asiento `purgar` sobrevive, owner-only. |
| `verify:incidentes:pg` | `verify-incidentes-pg.ts` | Incidentes durables: grants, anti-forge, append-only, fix del re-brick (`emitirEnTx`). |
| `verify:cosecha:pg` | `verify-cosecha-pg.ts` | Cosecha con dobles: satisfecho→'lista'+consume; guard de bytes; fallido/en_curso. |
| `verify:disparo:pg` | `verify-disparo-pg.ts` | Disparo: app encola solo por el SD; `drenarBuilds` corre planner + arranca. |
| `verify:ventana:pg` | `verify-ventana-pg.ts` | Ventana de 30 días de ajustes gratis anclada a la entrega. |
| `verify:reparaciones:pg` | `verify-reparaciones-pg.ts` | Circuit breaker de reparaciones (latch persistente, cuenta builds fallidos). |
| `verify:pgstate:pg` | `verify-pgstate-pg.ts` | `PgStateRepo`: une el pipeline M0 real con el enforcement de la BD. |
| `verify:adaptador:pg` | `verify-adaptador-pg.ts` | Adaptador HTTP: traducción Request→Response + happy-path real contra Postgres. |
| `verify:rutas` | `verify-rutas.ts` | Anti-olvido: escanea `web/app/api/**/route.ts`, falla si un verbo mutante no pasa por `ruta()`. |
| `verify:storage` | `verify-storage.ts` | `R2Storage` con doble del cliente S3 (comandos correctos, paginación, `existe`). |
| `verify:sandbox` | `verify-run-sandbox.ts` | Sandbox puente con python real: fuga de secretos, `ulimit`, timeout, cotas. |
| `verify:cma` | `verify-cma-clasificar.ts` | `clasificarSesion()` sin credenciales: desenlace pasa/falla/sigue. |
| `verify:webhooks:handlers:pg` | `verify-webhooks-handlers-pg.ts` | Handlers como rol `automata_webhook` (RLS real): caza el no-op silencioso. |
| `verify:pg` | `verify-pg.ts` | Aislamiento por el camino de código real (Node → pg → RLS), rol no-dueño. |
| `verify:cuota:pg` | `verify-cuota-pg.ts` | Enforcement de cuotas: ni el rol de app se salta el tope (triggers + SD). |

Scripts que **no** son verify (mismo `package.json`): `typecheck` (tsc), `m0` (build real),
`intake:live`, `planner:live` (agentes reales, gastan dinero).

---

## 5. Rutas HTTP y crons

Todo se cablea en `web/lib/automata/wiring.ts`; cada `route.ts` queda en 1-2 líneas.

### 5.1 Rutas de request (por `ruta()` → 8 capas)

| Ruta | Verbo | Endpoint | Acción / rol | Archivo route |
|---|---|---|---|---|
| `/api/orgs/[orgId]/automatizaciones` | POST | `crearAutomatizacionEP` | `crear_build` (admin) | `automatizaciones/route.ts` |
| `/api/orgs/[orgId]/construir` | POST | `solicitarBuildEP` | `crear_build` (admin) | `construir/route.ts` |
| `/api/orgs/[orgId]/ejecutar` | POST | `ejecutarEP` | `ejecutar` (admin+operador) | `ejecutar/route.ts` |
| `/api/orgs/[orgId]/miembros` | POST | `invitarEP` | `invitar` (admin, **step-up MFA**) | `miembros/route.ts` |
| `/api/orgs/[orgId]/miembros` | DELETE | `quitarMiembroEP` | `quitar_gente` (admin, step-up; no deja sin admin) | `miembros/route.ts` |
| `/api/orgs/[orgId]/ejemplo` | POST | `subirEjemplo` (upload) | `crear_build`, multipart + gate | `ejemplo/route.ts` |

`middleware.ts`: **default-deny** de páginas (Clerk `auth.protect()` salvo allowlist pública);
la API no la fuerza el middleware — se autentica en el pipeline (401 JSON).

### 5.2 Webhooks (por firma HMAC, **no** por las 8 capas)

| Ruta | Fuente | Rol de BD | Archivo |
|---|---|---|---|
| `/api/webhooks/cma` | CMA (standard-webhooks) | `automata_webhook` (`DATABASE_URL_WEBHOOK`) | `webhooks/cma/route.ts` |
| `/api/webhooks/stripe` | Stripe | `automata_webhook` | `webhooks/stripe/route.ts` |

`webhook()` (`wiring.ts:122-134`) usa `req.text()` (cuerpo **crudo**, nunca `req.json()`).

### 5.3 Crons (por `CRON_SECRET`, pool **DUEÑO**)

| Ruta | Función | Frecuencia (`vercel.json`) | Qué hace |
|---|---|---|---|
| `/api/cron/reaper` | `cronReaper` → `reaparBuildsColgados` | `*/10 * * * *` | Marca 'failed' builds colgados + emite incidente. |
| `/api/cron/cosecha` | `cronCosecha` → `drenarCosecha` | `*/2 * * * *` | Drena el outbox de cosecha (CMA → R2 → confirma). |
| `/api/cron/disparo` | `cronDisparo` → `drenarBuilds` | `*/2 * * * *` | Drena `build_pendiente` (planner + arranca CMA). |

`autorizadoCron` (`wiring.ts:156-162`) compara `Authorization: Bearer <CRON_SECRET>` en
tiempo constante, fail-closed.

---

## 6. Puertos inyectables (para cambiar impl sin tocar llamadores)

`core/src/types.ts` define los puertos; el wiring elige la implementación:

| Puerto | Impl M0 / dev | Impl producción |
|---|---|---|
| `Storage` | `LocalStorage` | `R2Storage` |
| `StateRepo` | `MemoryStateRepo` | `PgStateRepo` |
| `BuildClient` / `BuildClientAsync` | (doble en tests) | `CmaBuildClient` |
| `RunExecutor` | `LocalPythonExecutor` (puente a5-Fase 0) | `ContainerRunExecutor` (gVisor, a5-Fase 2) |
| `Sesion` / `RateLimiter` | fakes en `verify:http` | Clerk / Upstash (`wiring.ts`) |

**Decisión de este ciclo**: el runner objetivo es **contenedor gVisor self-hosted**
(a5-Fase 2). El swap `LocalPythonExecutor → ContainerRunExecutor` es parte del checklist.

---

## 7. Errores tipados (el contrato entre capas)

El pipeline traduce `RAISE` de la BD a HTTP:

| Error TS | Origen | HTTP | Traductor |
|---|---|---|---|
| `NoAutorizado` | `assertCan` (rol/cross-org) | 403 | `pipeline.ts:99` |
| `CuotaExcedida` | `CUOTA_EXCEDIDA:*` (triggers/`app_consumir`) | 402 | `pipeline.ts:100`, `comoCuota` |
| `ServicioSuspendido` | `SERVICIO_SUSPENDIDO:*` (kill-switch/org) | 503 | `pipeline.ts:101`, `comoSuspension` |
| `AjusteNoPermitido` | `AJUSTE_NO_PERMITIDO:*` (ciclo/breaker) | (según endpoint) | `ciclo/servicio.ts:79-86` |
| `EntradaRechazada` / `EntradaEnRevision` | gate de entrada | 422 | `wiring.ts:236-238` |

---

## 8. Checklist para activar en producción

Todo lo de abajo es **infra/llaves, no código** — el cableado ya existe. Ver `web/.env.example`.

- [ ] **Credenciales** en `.env.local` / Vercel / Neon:
  - `DATABASE_URL` (rol `automata_app`), `DATABASE_URL_OWNER` (migraciones/crons),
    `DATABASE_URL_WEBHOOK` (rol `automata_webhook`).
  - `APP_ORIGIN` (sin slash final), Clerk (`CLERK_*`, con `mfaVerifiedAt` en el session token),
    Upstash (`UPSTASH_*`), `ANTHROPIC_API_KEY`, R2 (`R2_*`), Stripe (`STRIPE_*`), `CRON_SECRET`,
    `CMA_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`.
- [ ] **Aplicar el schema** con el rol **dueño**: `psql "$DATABASE_URL_OWNER" -f core/db/schema.sql`
  (idempotente). Crea los roles `automata_app` y `automata_webhook`; fija sus passwords fuera de banda.
- [ ] **Sembrar** `subscriptions` por org (la app no puede crear tenants: `orgs` es owner-only).
- [ ] **Webhooks** en las consolas de **CMA** y **Stripe** apuntando a `/api/webhooks/{cma,stripe}`,
  con sus secretos (`whsec_…`). El webhook de CMA se registra a mano (no hay API para darlo de alta).
- [ ] **Crons** en Vercel (requiere plan Pro): ya declarados en `web/vercel.json`
  (`reaper` 10 min, `cosecha`/`disparo` 2 min).
- [ ] **Runner gVisor** desplegado en su propia infra (Fly/Cloud Run Jobs/VM con Docker/nerdctl +
  `runsc`), imagen con python + deps pre-horneadas; **swap** `LocalPythonExecutor → ContainerRunExecutor`.
- [ ] **Verificar** contra el Postgres real: `npm run verify:pg` + toda la suite `*:pg`.

Residuales de diseño (no bloquean el activar, sí el escalar): garantía anti-escape del sandbox
CMA (preguntar a Anthropic, docs/11 §12), y el cambio de **plan** en `procesarStripe`
(hoy solo transiciona estado activa/morosa/cancelada; el price del evento está PENDIENTE,
`webhooks/handlers.ts:84-91`).

---

## Referencias cruzadas

Este doc es el índice del código; el *porqué* de cada decisión vive en los docs de diseño:
04 (multitenancy/RLS), 06 (pricing/cuotas), 08 (ciclo de vida), 09 (componentes/vista),
11 (threat model), 13 (auth y webhooks), 14 (controles de seguridad),
`docs/decisiones-runtime.md` (runtime) y `docs/plan-fase-1.md` (el plan que esto ejecutó).
