# Automata — contexto del proyecto

> Contexto para retomar el proyecto en cualquier sesión. Conciso a propósito:
> el detalle vive en los documentos; esto es el mapa.

## Qué es

SaaS donde un cliente **describe su proceso** en lenguaje natural y un equipo de
agentes de IA lo **entiende, construye, prueba y publica** como una
"automatización" lista para usar desde su portafolio. El cliente **nunca ve
código, agentes ni progreso** — solo el resultado. Mercado objetivo: **PyMEs
mexicanas** (hoteles, restaurantes, despachos). Idea original del fundador:
"una página donde el cliente entra, describe su proceso, pica un botón, y una
serie de agentes piensa, planea, programa, ejecuta".

## Estado de implementación (actualizado 2026-07-30)

> **El backend de Fase 1 ya existe.** Este documento nació como mapa de
> *planeación*; buena parte de lo que describía como diseño hoy es **código real**
> en `core/` (motor framework-agnóstico, TS+tsx) envuelto por `web/` (wiring
> Next 16). Lo de abajo resume qué del mapa ya está construido, con evidencia
> (archivo:línea real) y el `verify` que lo prueba. Lo que aún es plan NO se
> marca como hecho.

| Pieza del doc | Estado | Evidencia | Verify |
|---|---|---|---|
| Multitenancy / RLS (docs/04) | **Construido** | `core/db/schema.sql:773-798` (RLS FORCE + política `aislada_por_org` en 7 tablas); `core/src/db/pg.ts:25-51` (`crearPoolApp` + `afirmarRolSeguro` rechaza super/bypassrls) | `verify:pg`, `verify:pgstate:pg` |
| Cuota / pricing (docs/06) | **Construido** | `core/src/billing/` (reserva→confirma, cobro al arrancar, downgrade con excedente en solo-lectura) | `verify:cuota:pg`, `verify:plan:pg` |
| Auth / pipeline 8 capas (docs/13) | **Construido** | `core/src/http/pipeline.ts:43-51` (`autorizar`: 0 rate → 1 authn → método → 2 CSRF → 3 org → conOrg{6 membresía → 7 assertCan → 5 step-up}) | `verify:http`, `verify:rutas`, `verify:adaptador:pg`, `verify:auth` |
| Onboarding / org dinámica / MFA (2026-07-28) | **Construido** | `core/src/ops/onboarding.ts` + SD `app_provisionar_usuario`/`app_orgs_de_usuario` (`core/db/schema.sql`, alta owner-only acotada por user, idempotente, advisory-lock); webhook `web/app/api/webhooks/clerk` (`user.created` → org+plan base+admin) + `GET /api/yo` (org desde la MEMBRESÍA, no env; onboarding perezoso); step-up lee el claim `fva` de Clerk (`web/lib/automata/wiring.ts`) | `verify:onboarding:pg` (+ probado en vivo: `/api/yo` resuelve/provisiona) |
| Ciclo de vida (docs/08) | **Construido** | `core/src/ciclo/servicio.ts:190-228` (`confirmarAjuste` con SAVEPOINT `tras_entrega` = entrega garantizada; 3 ajustes + congelado; circuit breaker con latch) | `verify:ciclo:pg`, `verify:ventana:pg`, `verify:reparaciones:pg` |
| Kill-switch / offboarding (docs/04, 05) | **Construido** | `core/src/ops/killswitch.ts:54-87` (`verificarFreno`, `suspenderOrg`, `purgarOrg` owner-only) + triggers DB | `verify:killswitch:pg`, `verify:offboarding:pg` |
| Intake / componentes (docs/09, 10) | **Construido** (núcleo determinista) | `core/src/intake/` (adapter + validator), `core/src/vista/resolver.ts` | `verify:intake`, `verify:planner` |
| Entrada multi-formato / gate (docs/11 §4bis) | **Construido** | `core/src/entrada/` (validador XXE/zip-bomb/pixel-flood/spoofing + `puente.ts` cableado a build/run/upload) | `verify:entrada`, `verify:entrada:gate` |
| Webhooks + cosecha (docs/03, 13) | **Construido** | `core/src/webhooks/` (firma HMAC, dedupe, handlers), `core/src/pipeline/cosecha.ts` + `disparo.ts` | `verify:webhooks`, `verify:webhooks:handlers:pg`, `verify:cosecha:pg`, `verify:disparo:pg` |
| Observabilidad / incidentes (docs/05) | **Construido** | `core/src/ops/incidentes.ts` (append-only, SD, reaper emite incidentes) | `verify:incidentes:pg` |
| Data plane: storage + CMA | **Construido** | `core/src/storage/r2.ts` (R2/S3-compat, `existe()`), `core/src/cma/build.ts` (arrancar/cosechar + clasificarSesion) | `verify:storage`, `verify:cma` |
| Runner sandbox (docs/02, 11) | **Fase 0 probada; gVisor cableado** | `core/src/run/executor.ts` (`LocalPythonExecutor` endurecido: env allowlist, ulimit, kill de grupo) probado; `core/src/run/container-executor.ts:12-97` (jaula gVisor `runsc`, `--network none`, `--read-only`, `--cap-drop ALL`, `--pids-limit`) **cableado, se prueba al desplegar** | `verify:sandbox` |
| API de lectura (GET) / UI real (docs/16) | **Construido (2026-07-27)** | `core/src/http/endpoints.ts` (listar/ver automatizaciones, equipo `/miembros`, cuenta `/cuenta`) + `web/lib/automata/lectura.ts` (el front consume las APIs, con fallback al prototipo demo) | `verify:lectura:pg`, `verify:cuenta:pg` |
| Run real (orquestación + HTTP) (docs/16) | **Construido (2026-07-27)** | `core/src/pipeline/run.ts` (`ejecutarAutomatizacion`) + `web/lib/automata/wiring.ts` (`correrAutomatizacion`: multipart → Run local; prod → 503, runner aislado) | `verify:ejecutar:pg` |
| Modo dev local (docs/16) | **Construido (2026-07-27)** | `web/lib/automata/dev.ts` (bypass de auth doble-gated a no-producción) + `middleware.ts` + `core/scripts/seed-dev-pg.ts`: el producto real corre local **sin credenciales** | (corre local; runbook docs/16) |
| **Intake → build cableado** (2026-07-29) | **Construido** | Aprobar el spec en `/nueva` SÍ construye: dropzone real que captura el `File`, `construirDesdeSpec` en `web/lib/automata/lectura.ts` (sube el ejemplo → `POST /construir`) usando el adaptador CANÓNICO `core/src/intake/adapter.ts` (al build viaja el criterio TÉCNICO, no el de cliente); `almacen()` en el wiring = R2 en prod / LocalStorage en dev | probado en vivo (upload → cola → drainer); `tsc` + `next build` |
| **Equipo compartido / invitaciones** (2026-07-29) | **Construido** | Tabla `invitaciones` (por CORREO, con RLS y contando contra la cuota) + SD `app_aceptar_invitaciones`; `app_provisionar_usuario` gana `p_correo` → un invitado entra al equipo que lo invitó en vez de recibir org propia. Antes se inventaba el `user_id` del local-part del correo y la fila quedaba huérfana | `verify:onboarding:pg` (secciones 7-8), `verify:cuota:pg` |
| **Posventa / ajustes** (2026-07-30) | **Construido** | `core/src/pipeline/ajuste.ts` (`arrancarAjuste` construye la versión **>1** — antes NADIE abría sesión de CMA para una v2 — y `drenarAjustes`); tabla `ajuste_pendiente` + SD `app_solicitar_ajuste`; `pedirAjusteEP` (`POST /orgs/:orgId/ajustar`, exige `confirmado:true`); cron `/api/cron/ajustes`; `automatizaciones.spec`/`ejemplo_key` persistidos (sin ellos un ajuste no tiene con qué construir); front `/ajustar` real | `verify:ajuste:pg` (25 checks) |
| **Stripe: enganche** (2026-07-30) | **Parcial** — falta checkout/portal | SD `app_stripe_vincular` (write-once; el eslabón que faltaba: `stripe_customer_id` no tenía escritor, así que TODO evento de Stripe era no-op silencioso); el receptor extrae `price` + `client_reference_id`; `planDePrecio()` mapea desde `STRIPE_PRICE_*`; el handler **devuelve** el cambio de plan y el wiring lo aplica TRAS el commit (hacerlo dentro deadlockeaba con `aplicarDowngrade`) | `verify:stripe:pg` (17 checks) |

**Marco de pruebas:** **35** scripts `verify:*` en `core/package.json` (unit +
contra Postgres real, sufijo `:pg` — 20 de ellos). Corren **en verde en secuencia**;
`tsc --noEmit` (core y web) y `next build` OK. La BD de pruebas es un Postgres temporal
en el puerto **55432**.

> ⚠️ **Si un `verify:*` falla al correr la suite pero pasa aislado, sospecha
> hermeticidad, no un bug del producto.** Los drainers drenan la cola **global**
> (`build_pendiente`, `ajuste_pendiente`), así que una fila de otro test —o encolada a
> mano en dev— desvía los conteos. `verify:disparo:pg` y `verify:ajuste:pg` vacían su
> cola al arrancar por eso.

**Hallazgo que corrige el diseño previo:** el webhook de CMA es *thin* — sus
`data.type` reales **accionables** son `session.status_idled` (→ encola cosecha) y
`session.status_terminated` (→ falla); el resto (`session.outcome_evaluation_ended`,
etc.) es informativo. El ÉXITO de un build sólo se sabe **re-consultando la
sesión**, no por el evento. Esto corrige los nombres inventados
(`session.completed`, etc.) que docs/13 daba por buenos (ver corrección en línea
en el índice, abajo).

### Falta para producción (actualizado 2026-07-30)

**Ya listo:**
- ✅ **Neon migrado** con todo el esquema (incluidas `invitaciones`, `ajuste_pendiente`,
  las SD nuevas y `app_stripe_vincular`). Verificado: RLS FORCE activo, los roles
  `automata_app`/`automata_webhook` no son superuser ni bypassrls, y los `GRANT EXECUTE`
  de las SD están.
- ✅ **`ANTHROPIC_API_KEY` válida y con crédito** (probada contra `/v1/models` y con un
  mensaje real; `claude-opus-4-8` disponible). Esto desbloquea intake y planner.

**Falta (necesita llaves/consolas/infra, NO código):**
- **Upstash** — sin las envs, el rate-limiter **truena en la primera request** de prod
  (`Redis.fromEnv()` lanza fuera del try/catch).
- **R2** — sin bucket no se sube el ejemplo ni se guarda el artefacto.
- **`CRON_SECRET` + Vercel Pro** — sin los 4 crons nada se drena (el build queda encolado
  para siempre).
- **Alta de webhooks en consolas**: Clerk (`user.created`), CMA, Stripe. Cada uno da su
  `whsec_`.
- **Runner gVisor** — el Run responde **503** fuera de dev; hay que desplegar el host con
  `runsc` y cambiar `LocalPythonExecutor` → `ContainerRunExecutor`.
- **Managed Agents (beta)** habilitado en la cuenta de Anthropic (se sabrá al primer build).
- **Resend con dominio verificado** — sin él los avisos solo llegan a tu propio correo.

**Falta de CÓDIGO (lo que sí es trabajo pendiente):**
- **Stripe: checkout + portal de cliente.** Es lo único que queda de Stripe. Necesita
  `STRIPE_SECRET_KEY` y los 3 `price_…` reales para poder probarse de verdad — decisión
  deliberada: no se escribe código de cobro que no se pueda ejecutar.
- **Selector multi-org** en el front (`orgActual()` toma `orgs[0]` fijo).
- **Correo de invitación**: la invitación existe pero nadie le avisa a la persona; se
  entera al registrarse (`TipoCorreo` no tiene `'invitacion'`).
- **Re-verificación de MFA** en el front cuando el `fva` envejece (>5 min → 403 sin salida).
- **`correrRegresion()` devuelve `"indeterminado"`** a propósito hasta que exista el runner:
  hoy **nada se clasifica como reparación gratis automáticamente**. La UI lo dice de frente.
- **Renombrar la org** autogenerada ("Mi negocio") — no hay endpoint.
- **Formula injection en las salidas** xlsx/csv sin neutralizar (`=`,`+`,`@`). Hoy la
  exposición es baja porque las salidas ni se conservan; al conservarlas, cerrar esto.

## Estado actual

| Parte | Estado |
|---|---|
| Planeación de arquitectura | **Completa** — 13 documentos, 2 curtidos con crítica adversarial |
| Front | **Ya NO es solo apariencia.** Portafolio, cuenta, equipo, detalle, Ejecutar, `/nueva` (intake→build) y `/ajustar` (posventa) consumen el backend REAL, con fallback a `lib/datos.ts` cuando no hay backend. Lo que sigue falso: precio y método de pago en `/cuenta` (viven en Stripe, sin cablear) |
| Spike (prueba técnica) | **Corrido ✓ — 3/3 casos, ~$1.8/build real** (ver `spike/RESULTADO.md`) |
| Backend / producto real | **Actualización (2026-07-30): el ciclo COMPLETO del cliente existe en código** — describir → construir → ejecutar → **pedir un cambio** (posventa), con equipo compartido real y el enganche de Stripe. `core/` (TS+tsx) + `web/` (wiring Next 16); **35 `verify:*` en verde**, typecheck + `next build` OK. Falta: activar infra (Upstash/R2/crons/gVisor) y el checkout de Stripe. Detalle en "Estado de implementación" |
| Primer build real de punta a punta | **NO corrido todavía.** La llave ya sirve y el camino está cableado y probado por partes; falta lanzarlo (cuesta ~$1.8 y confirma si Managed Agents está habilitado) |

## Los riesgos abiertos (no se resuelven con más papel)

1. ~~**El spike sin correr.**~~ **RESUELTO (2026-07-20).** 3 casos a ciegas,
   **3/3 aprobados**, costo real **~$1.8/build** (consola: $5.29 los 3). Muy bajo
   la asunción de ~$3 y el umbral de $5. Cubrió 3 dominios (dashboard, pivote,
   consolidación) y uno se auto-corrigió (2 iteraciones). Detalle en
   `spike/RESULTADO.md`. Nota: run.js subcuenta ~1.4×; el número real está en la
   consola.
2. **Cero clientes consultados.** Nadie ha confirmado que pagarían ni cuál es el
   dominio. Enseñar el prototipo a 5 personas con el problema. **Ahora es el
   riesgo #1 abierto.** Evidencia *indirecta* de mercado en
   `docs/mercado-microsaas.md` (el producto es negocio probado; el ICP PyME-MX
   sigue sin validar).
3. ~~**Riesgo técnico del backend (auditoría de riesgo + Top-5).**~~
   **Actualización (2026-07-26): CERRADO EN CÓDIGO.** Se hizo la auditoría de
   riesgo y el Top-5 se **implementó** en el motor de Fase 1: aislamiento por org
   (RLS FORCE + rol no-dueño), cuota sin oversell, entrega garantizada del ajuste
   (anti-brick), kill-switch DB-enforced, gate de entrada contra archivos
   maliciosos y jaula gVisor cableada para el Run. Evidencia y `verify` en la
   sección "Estado de implementación". Queda **deferido** (no es código) activar
   llaves/infra y desplegar el runner gVisor.

4. **El primer build real, sin correr.** Todo el camino está cableado y probado por
   partes (con dobles: sin CMA, sin R2, sin modelo), pero **nunca ha corrido de punta a
   punta con dinero real**. Es lo único que confirma que Managed Agents está habilitado en
   la cuenta y que el prompt de ajuste produce algo útil. Cuesta ~$1.8. **Riesgo #2 hoy.**

**Actualización (2026-07-30):** con el spike resuelto (#1 histórico) y el riesgo técnico
cerrado en código (#3), quedan dos: **#2 clientes** (sigue siendo el #1 real — nadie ha
confirmado que pagaría) y **#4 el primer build**. Ojo con la trampa de esta sesión: se
construyó *mucho* (equipo, posventa, Stripe) y todo está probado con dobles — pero
**probado-con-dobles no es probado-con-dinero**. Seguir agregando motor es, a estas
alturas, procrastinar el #2 y el #4.

## Para retomar (lee esto primero) — 2026-07-30

**Lo siguiente que hay que hacer, en orden:**

1. **Correr el PRIMER BUILD REAL de punta a punta.** Todo está cableado y la llave sirve.
   Cuesta ~$1.8 y es lo único que confirma Managed Agents + que el resultado es útil.
   Camino: `/nueva` → describir → aprobar (sube ejemplo + encola) → disparar el cron a mano
   con `curl -X POST /api/cron/disparo -H "Authorization: Bearer $CRON_SECRET"` → luego
   `/api/cron/cosecha`. Requiere el modo dev local (docs/16) y `DATABASE_URL_OWNER`.
2. **Stripe: checkout + portal.** Crear los 3 productos en Stripe (test): Base $499, Pro
   $999, Equipo $1,999 MXN/mes → pegar los `price_…` en las envs (el mapeo ya funciona sin
   tocar código) y entonces escribir el checkout con la llave de test a la vista.
3. **Enseñárselo a 5 PyMEs.** Riesgo #2, el que no se arregla con código.

**Trampas que ya nos costaron horas (no repetirlas):**
- **Editar `core/` no lo ve `web/`** hasta correr `pnpm install` en `web/` (pnpm COPIA el
  `file:../core`) — y los `verify:*` pasan en verde mientras el front corre código viejo.
  El síntoma parece un bug del producto. Reiniciar `pnpm dev` después.
- **`~/Desktop` y TCC de macOS**: ver "Notas de entorno".
- **Dos fuentes de env**: `web/.env` y `web/.env.local` tienen las mismas claves y
  `.env.local` GANA. Editar la equivocada parece "no funcionó". Y `web/.env.local` puede
  quedar apuntando a la BD **local** (`127.0.0.1:55432`) tras una sesión de pruebas —
  revisarlo antes de concluir nada sobre Neon.
- **No dupliques contratos que ya existen en `core/`.** Aquí nacieron los dos peores bugs
  de la sesión: un mapeo de spec a mano que invirtió `criterio`/`criterio_cliente` (el
  Verifier quedaba sin nada ejecutable) y un cambio de plan que iba a reimplementar
  `aplicarDowngrade` en SQL. Busca primero si el core ya lo hace.

## Estructura del repo

```
PLAN.md            visión de producto, alcance (§0), stack, fases
ARQUITECTURA.md    resumen técnico
docs/              detalle por pieza (índice abajo)
web/               prototipo front — Next.js 16 + pnpm (ver web/CLAUDE.md, web/DESIGN.md)
spike/             prueba técnica — Node + npm (raíz)
```

## Índice de documentos (docs/)

| # | Tema | Nota |
|---|---|---|
| 01 | Artefacto | qué produce el Builder, cómo se ejecuta |
| 02 | Runtime | dónde corren las automatizaciones; gVisor desde el 1er cliente |
| 03 | Pipeline de build | estados, webhooks, reintentos, reserva de cuota |
| 04 | Multitenancy | aislamiento, RLS (FORCE + rol no-dueño), borrado, 2 roles |
| 05 | Observabilidad y costos | margen por org; el riesgo es ganar clientes y perder dinero |
| 06 | Pricing | **MXN provisional** ($499/$999/$1,999); tensión costos-USD |
| 07 | Entornos y despliegue | prompts = despliegue de producción; evals |
| 08 | Ciclo de vida | 3 ajustes por automatización; cambio ≠ reparación |
| 09 | Sistema de componentes | el agente declara vistas, no escribe HTML; **catálogo v1 construido** en el prototipo |
| 10 | Intake | el agente entrevistador (opción múltiple → spec validado) |
| 11 | Threat model | ejecutar código de IA es el producto; escape de contenedor = riesgo #1 |
| 13 | Auth y webhooks | **IMPLEMENTADO**: pipeline de 8 capas (`core/src/http/pipeline.ts:43-51`), firma de webhooks (`core/src/webhooks/`). **Actualización (2026-07-26):** los nombres de evento de CMA que este doc daba por buenos (`session.completed`, etc.) eran **inventados**; los `data.type` reales accionables son `session.status_idled` / `session.status_terminated` (el resto, `session.outcome_evaluation_ended` etc., es informativo) y el ÉXITO sólo se sabe re-consultando la sesión (webhook *thin*). |
| 14 | Controles de seguridad | **matriz de casos comunes** (65, 5 dominios) estilo OWASP: caso → postura → capa → milestone → estado; une docs/13+11+04 |
| 15 | **Motor implementado** | **NUEVO (2026-07-26):** catálogo maestro de lo construido en Fase 1 — módulos de `core/`, modelo de seguridad en la BD, loop async de build de punta a punta, la suite de `verify:*` (31), rutas/crons y el checklist para activar en producción |
| 16 | **Modo dev local** | **NUEVO (2026-07-27):** runbook para correr el producto **real** (front → backend real: RLS, cuota, Run que ejecuta código) en la máquina **sin credenciales** — bypass de auth doble-gated a no-producción, siembra con `seed:dev`, qué es real vs. falso, y el Run local de punta a punta |

(No hay docs/12; el 13 se numeró así a propósito.)

> ⚠️ **La doc de `docs/` va DETRÁS del código (2026-07-30).** Los documentos son buen mapa
> del *diseño*, pero para saber qué existe hoy manda el **código** y la tabla "Estado de
> implementación" de arriba. Concretamente: **docs/15** (catálogo del motor) no incluye
> invitaciones, posventa (`pipeline/ajuste.ts`, `ajuste_pendiente`) ni el enganche de
> Stripe; **docs/08** describe el ciclo de vida como no expuesto por HTTP, cuando ya hay
> `POST /ajustar` + cron; **docs/16** ya no aplica en lo de la env de org (obsoleta, hoy es
> `/api/yo`). Si un doc y el código se contradicen, **cree al código y actualiza el doc**.

## Decisiones clave tomadas (para no re-litigar)

- **Build vs Run separados.** El Build (agentes, caro, 1 vez) y el Run
  (ejecutar código, barato, N veces) son distintos. El Run **no usa modelos**.
- **Managed Agents (Anthropic)** para el Build en el MVP; runner propio en Fase 2.
- **Decisiones de runtime** (resuelven docs/11 §12) en `docs/decisiones-runtime.md`,
  con hechos de CMA confirmados: **build se blinda en CMA** (`packages`
  pre-instalados + `networking: limited` sin hosts → sin red, sin runner propio en
  el MVP); **Run <1¢** ($0.08/session-hour, sin modelos, NO $0.30) → topes de
  ejecución holgados; **environment por org** como mitigación de aislamiento
  (gVisor en el runner de Fase 2). Residuales: garantía anti-escape del sandbox
  (preguntar a Anthropic) y si el Run corre sin modelo (probar con API).
- **Modelo del build:** intake (Sonnet 5) → planner (Opus) → builder (Opus) →
  verifier (Opus, contexto fresco). 6 roles de modelo, solo 2 son agentes reales.
- **Alcance MVP:** automatizaciones **sin estado** (archivo → proceso → resultado).
  **NO** CRM ni apps con datos propios (eso es otro producto — docs/09 §6).
- **Sin integraciones OAuth ni cron/webhooks en el MVP** (Fase 3).
- **Entrevista:** opción múltiple, preguntas de **negocio** nunca técnicas,
  máx. 2 rondas. El cliente aprueba un spec antes de construir.
- **Precios MXN provisionales** — dependen del costo real por build (spike).
- **Equipo:** cuenta del negocio, portafolio compartido, **2 roles**
  (admin crea/ajusta/invita/factura, operador solo ejecuta).
- **Marca "Automata" es provisional** (se cambia en `web/lib/marca.ts`).
- **Se invita por CORREO, nunca por user_id.** El id real lo asigna Clerk al registrarse,
  así que la invitación ESPERA en la tabla `invitaciones` y se vuelve membresía cuando esa
  persona se da de alta (con su correo **verificado** — aceptar uno sin verificar dejaría
  colarse a un equipo ajeno poniendo el correo de otro). Una invitación pendiente **ocupa
  lugar** del plan; si no, un admin apalabraría 50 correos con un plan de 3.
- **El tipo de ajuste lo decide la REGRESIÓN, no el cliente** (docs/08 §2): se corre el
  ejemplo original contra la versión vigente. Falla → **reparación gratis**; pasa o
  indeterminado → **cambio** que gasta 1 de 3. Por eso NO hay un botón de "reportar falla"
  que prometa gratis: sería una promesa que el dato puede desmentir.
- **Preguntar antes de cobrar.** Como hoy la regresión sale `indeterminado` (sin runner) y
  eso se clasifica como cambio, la UI le muestra el costo ANTES y `pedirAjusteEP` **exige
  `confirmado:true`**. Nadie gasta un ajuste sin haberlo visto.
- **Cambio de plan: upgrade INMEDIATO con prorrateo** (lo que Stripe cobra al instante).
  Es lo que el cliente espera —pagó más para poder usarlo ya— y encaja con los triggers de
  cuota, que leen el plan vivo de la BD.
- **Stripe es la fuente de verdad del plan**: se deriva del `price` del evento, nunca de la
  app. Un `price` desconocido NO toca el plan (darle uno que no pagó, o quitarle el que
  pagó, son los dos errores caros).
- **El request solo ENCOLA; lo caro va en un drainer.** Vale para builds y para ajustes:
  la regresión, el planner y la sesión de CMA tardan segundos y no deben colgar al cliente
  ni retener una conexión de BD. (El intake es la excepción conocida y está marcada como
  follow-up.)
- **No es Zapier.** Automata NO es automatización de integración (conectar apps
  A→B con disparadores); es "desastre → resultado terminado y verificado", a
  demanda, para PyME no-técnica. La respuesta a "¿esto no es Zapier?" vive en
  `docs/posicionamiento.md` (munición de pitch).
- **Insumos multi-formato por plan (switch).** Las automatizaciones de extracción
  tragan XML/PDF/fotos y rutean **archivo por archivo** (XML/QR = gratis; foto
  pelona = OCR, el único rung que cuesta, gateado al plan alto). **Nunca inventa**;
  lo ilegible va a "a revisar". El "agente extra" es esto (determinista), NO un
  chatbot conversacional (que metería modelo en el Run + no-determinismo).
  **Pendiente: mini-spike de OCR** para el costo real del rung de foto — spec en
  `docs/automatizaciones-fichas.md` (§ "Pendiente: mini-spike de OCR"). **Cada
  formato nuevo (xml/zip/jpg) es un vector de seguridad** — threat model en
  `docs/11` §4bis (XXE, ZIP-bomb, pixel-flood, egress de OCR, sobre de lote); el
  spike/regresión debe ejercerlos con fixtures maliciosos.

## Cómo correr

```bash
# Front (prototipo)
cd web && pnpm install && pnpm dev        # → localhost:3000

# Spike (prueba técnica) — desde la raíz
npm install
npm run datos                              # genera/regenera datos de prueba
export ANTHROPIC_API_KEY=sk-ant-...
npm run spike                              # corre el caso (Vitrales sintético)

# Motor de Fase 1 — desde core/ (agregado 2026-07-26)
cd core && npm install
npm run typecheck                          # tsc --noEmit
npm run verify                             # verify base (run → vista, sin BD)
# Verifies contra Postgres real (requieren la BD temporal en el puerto 55432):
npm run verify:pg                          # aislamiento / RLS
npm run verify:cuota:pg                    # cuota (reserva→confirma, sin oversell)
npm run verify:ciclo:pg                    # ciclo de vida (entrega garantizada)
npm run verify:killswitch:pg              # freno DB-enforced
npm run verify:ejecutar:pg                 # Run de punta a punta (Python real)
npm run verify:onboarding:pg               # alta + INVITACIONES (el invitado entra al equipo)
npm run verify:ajuste:pg                   # POSVENTA: construye la versión 2 + cola + drainer
npm run verify:stripe:pg                   # STRIPE: vincula customer, price→plan, downgrade
# ...son 35 scripts `verify:*` en core/package.json (sufijo :pg = con BD; 20 lo llevan)
# Al aplicar el esquema usa SIEMPRE -v ON_ERROR_STOP=1 (sin él deja la BD a medias).

# Modo DEV LOCAL — el producto REAL corriendo local, SIN credenciales (runbook: docs/16)
psql "postgres://postgres@127.0.0.1:55432/postgres" -f core/db/schema.sql  # schema (rol dueño)
cd core && npm run seed:dev                # siembra org+equipo+automatizaciones EJECUTABLES
# web/.env.local: AUTOMATA_DEV_AUTH=1, DATABASE_URL=…55432, APP_ORIGIN=http://localhost:3000,
#   AUTOMATA_DEV_STORAGE_DIR=<abs>/.dev-storage, DATABASE_URL_OWNER=…55432 (los crons),
#   CRON_SECRET=<openssl rand -hex 32> (para disparar los crons a mano con curl)
#   NOTA: NEXT_PUBLIC_AUTOMATA_DEV_ORG quedó OBSOLETA — la org se resuelve desde la
#   membresía vía GET /api/yo (que además provisiona al primer acceso).
cd web && pnpm dev                         # → localhost:3000 (portafolio/cuenta/equipo/detalle REALES + Ejecutar real)
```

- **Front, spike y motor son proyectos separados**: front usa `pnpm` en `web/`;
  el spike usa `npm` en la raíz; el motor usa `npm` en `core/`. No mezclar.
- ⚠️ **Si editas `core/`, corre `pnpm install` en `web/` para que el front lo vea.**
  `web` declara `automata-core` como `file:../core`, y pnpm lo **COPIA** a su store
  (`node_modules/automata-core` → `.pnpm/automata-core@file+..+core_zod…`): NO es un
  symlink al fuente. Sin ese `install`, el front sigue corriendo la versión anterior
  de core aunque `core/` ya esté arreglado — y los `verify:*` (que sí leen `../src`)
  pasan en verde, así que el síntoma parece un bug del producto. Ya pasó: el drainer
  del front descartaba un build tras 2 intentos porque usaba la copia vieja.
  Reinicia `pnpm dev` después del `install` (cambiar `node_modules` bajo el server
  lo tumba).
- Los `verify:*` con sufijo **`:pg`** necesitan un Postgres alcanzable (en las
  pruebas de Fase 1 se usó uno temporal en el puerto **55432**); los demás corren
  sin BD.
- El spike usa **Managed Agents (beta)** — si da error de acceso, hay que
  activarlo en la cuenta de Anthropic. Aparta ~$5 de crédito por corrida.

## Convenciones

- **Idioma de TODA la UI: español de México, tuteo, cero jerga técnica.** El
  cliente del producto no programa. Nada de "webhook", "API", "deploy".
- **El front YA NO es demo** (esta línea decía "100% demo, los botones animan pero no
  guardan nada" — era cierto hasta el 2026-07-27 y hoy engaña). Regla real: **datos
  reales con fallback a los falsos.** `web/lib/automata/lectura.ts` pega a las APIs y,
  si no hay backend/login, devuelve `null` y el llamador cae a `web/lib/datos.ts`, así
  el prototipo sigue vivo para enseñarlo. Un botón que "solo anima" hoy es un **bug**,
  no el diseño — pero **verifica antes de asumir cuál es cuál**: quedan piezas falsas a
  propósito (precio y método de pago en `/cuenta`, que viven en Stripe).
- **Sistema de diseño del front:** `web/DESIGN.md` (paleta sepia, tokens,
  catálogo de componentes, reglas de animación). El color acento (naranja) es
  SOLO para la acción principal de cada pantalla.
- **Next.js 16 tiene cambios importantes** vs. lo conocido — ver `web/AGENTS.md`
  y `web/CLAUDE.md` antes de tocar el front (params como Promise, sin
  `eslint.ignoreDuringBuilds`, etc.).

## Notas de entorno (no son bugs del código)

- **El repo es público** (`github.com/Aleman1205/app-automata`). No commitear
  secretos ni datos reales. `spike/datos/` está en `.gitignore`. Considerar
  volverlo privado antes de meter datos/keys reales.
- **git push** va con la cuenta `Aleman1205` vía `gh` (hay otra cuenta,
  `aaleman0`, que causaba 403 — ya resuelto).
- **El navegador de verificación se congela** tras varios scrolls en este
  entorno — es del entorno, no del código. Verificar por DOM
  (`javascript_tool`) es más confiable que screenshots con scroll.
- El disco de la máquina estuvo al límite; limpiar cachés si vuelve a pasar.
- **macOS puede revocar el acceso a `~/Desktop` (TCC) a media sesión.** El síntoma es
  `EPERM: operation not permitted` en TODO lo que lea el proyecto (`git`, `psql`, `grep`,
  hasta `cp`) mientras el resto del disco funciona — parece disco lleno y **no lo es**.
  Diagnóstico en 3 líneas: leer un archivo del proyecto (falla), uno del scratchpad
  (funciona), y uno de `~` fuera de Desktop (funciona) → es TCC, no el código. Se arregla
  dando "Acceso total al disco" (o "Carpeta Escritorio") a la terminal/app y
  **reabriéndola**; el permiso no aplica hasta reiniciarla.
- **El dev server del panel de preview puede quedar inservible** si su shell se creó antes
  de ese permiso: arranca con `getcwd: cannot access parent directories` y nunca escucha.
  No se recupera desde dentro — hay que reiniciar la app. Como salida de emergencia se
  puede levantar `pnpm dev` desde un shell que sí tenga permiso, pero conviene decirlo en
  voz alta porque lo normal es usar el panel.
- **`ON_ERROR_STOP=1` es obligatorio al aplicar el esquema.** Sin él psql sigue tras un
  error y deja la BD a medias, que es peor que fallar. Y el **SQL Editor de Neon no sirve**
  para `schema.sql`: si tiene el modo *Explain* activo prefija `EXPLAIN` (y `EXPLAIN DO …`
  es error de sintaxis), y además puede partir mal los cuerpos `$fn$…$fn$`. Usar `psql -f`.

## Datos de demostración del prototipo

El front simula el negocio **"Hotel Vitrales"** (plan Equipo): equipo de 5
personas (Ana Rivera = admin/usuaria actual; Luis, Carmen, Jorge = operadores;
Roberto = invitación pendiente). El caso del spike es un reporte de popularidad
de productos de restaurante (archivo real anonimizado → `spike/generar-gastos.js`).
