# Plan de construcción — Fase 1 (MVP)

> De "tengo docs" a "sé qué codeo el lunes". Secuencia de milestones para el MVP,
> apoyada en las decisiones ya tomadas: build+run en CMA sin runner propio
> ([docs/decisiones-runtime.md](decisiones-runtime.md)), sistema de vistas
> construido ([docs/09](09-sistema-de-componentes.md)), y el spike que ya probó el
> build ($1.8, 3/3). Fecha: 2026-07-21.

## Principio: rebanada vertical primero

Construye **una automatización de punta a punta** antes que el ancho. Y
**front-load lo riesgoso/novedoso** (el loop build→artefacto→run→vista), **difiere
el boilerplate** (auth, billing, RLS son caminos trillados — Clerk/Stripe/Neon —,
no deciden si el producto funciona, solo si es negocio).

**Matiz de seguridad (auditoría 2026-07-21).** Diferir ≠ improvisar. Los controles
de seguridad **estructurales** —los que evitan un olvido, no una feature— entran como
**línea base del esqueleto en M0** (validación Zod en la frontera, cabeceras, firma de
webhooks, el wrapper `withAuthz`, `afirmarRolSeguro`), aunque el *enforcement* de rol
y RLS se materialice en M2. La matriz completa de casos comunes (65, por dominio) vive
en **[docs/14 — controles de seguridad](14-controles-de-seguridad.md)**; abajo se
marcan `[SEG]` las tareas que salen de ahí.

## El stack (decidido)

| Capa | Elección | Nota |
|---|---|---|
| Front | Next.js 16 + Tailwind 4 + motion + Recharts | **Ya construido** (el prototipo) |
| Auth | Clerk (MFA obligatoria owner/facturación) | docs/13 |
| Base de datos | Postgres en Neon | RLS con **rol no-dueño + FORCE** (docs/04) |
| Workflows durables / webhooks | Inngest | `step.waitForEvent` para el webhook de CMA (docs/03) |
| Build + Run | Managed Agents (CMA) | **environment por org**; build con `packages` + `networking: limited` |
| Blob | Cloudflare R2 (S3-compat) | artefactos + salidas |
| Email | Resend | avisos de build listo |
| Billing | Stripe | planes $499/$999/$1,999; webhooks firmados |
| Hosting | Vercel (front + API) + Inngest | |

## La secuencia

### M0 — La rebanada que prueba el loop *(lo más riesgoso primero)*
**Objetivo:** el pipeline **build → artefacto → run → vista** corriendo en TU
infra, no solo en el script del spike.
**Construyes:**
- Esqueleto: API routes de Next + Neon (schema mínimo: orgs, automations,
  versions, runs) + Inngest + R2 + integración CMA.
- **Un usuario/org hardcodeado** (sin auth todavía).
- El pipeline: spec a mano (como `spike/casos.js`) → **build en CMA** (config
  confirmada: `packages` pre-instalados + `networking: limited` sin hosts) →
  artefacto (`automatizacion.py` + `manifiesto.json` + **`vista.json`**) → R2 →
  **run** sobre un archivo → **renderizar la vista** con los bloques del prototipo,
  **resolviendo `@resultado.*` de verdad** (el contrato de docs/09, por primera vez
  ejercido).
- **Reutiliza un caso del spike** (ya tiene artefacto probado) para de-riesgar.
- **`[SEG]` Línea base de seguridad del esqueleto** (docs/14 §pipeline): convención
  `Zod safeParse(body/query/params) → 400` en toda API route; cabeceras
  (CSP/HSTS/X-Content-Type-Options); el wrapper `withAuthz` **como único camino**
  para handlers con efecto (aunque en M0 la autz sea el usuario hardcodeado); **firma
  del webhook de CMA** (cuerpo crudo → `unwrap` → frescura ±5 min → dedupe), que M0
  ya necesita porque integra el webhook; job que deriva la org del **recurso firmado**,
  no del payload (anti *confused deputy*).
**Prueba:** la integración más novedosa funciona en tu sistema. **Cierra el
residual #2 de (b)** (¿el Run corre sin modelo? → aquí se mide).
**Difieres:** auth de usuarios, multi-tenant, billing (el enforcement; la *estructura*
de seguridad no se difiere).

### M1 — El intake real
**Objetivo:** reemplazar el spec a mano por el agente entrevistador.
**Construyes:** el intake ([docs/10](10-intake.md)) — entrevista (Sonnet) → spec →
rubric (planner). Cablear el `/nueva` del front (ya existe como demo) al intake
real.
**Prueba:** describir un proceso en lenguaje natural → aprobar spec → build → run.
El loop completo desde cero.

### M2 — Multi-tenancy + auth
**Objetivo:** usuarios y orgs reales, aislados.
**Construyes:** Clerk (MFA), Postgres **RLS con el rol no-dueño + FORCE**
([docs/04](04-multitenancy.md)), **environment de CMA por org** (mitigación de
aislamiento de (b)), 2 roles (admin/operador). Backear las pantallas app-mode del
front con datos reales.
- **`[SEG]` Auth (docs/14 §1):** `clerkMiddleware` + verificación server-side del JWT
  (issuer/JWKS) en cada request — **el control portante**; middleware **default-deny**
  con allowlist de rutas públicas (anti *forced browsing*); **CSRF** (SameSite +
  `Origin`/`Referer`); **step-up MFA** real (challenge de Clerk + recencia del factor)
  para las 4 acciones de `REQUIERE_STEPUP`; activar y **verificar** brute-force/bot de
  Clerk, MFA en el reset, y rotación de sesión (fixation); config de sesión (24 h
  inactividad **no** es default). Decidir alcance de **OAuth/social login**.
- **`[SEG]` Autorización (docs/14 §2):** cablear `assertCan`+`leerMembresia` **vía el
  `withAuthz`** de M0; **test enumerador de rutas** que falle si alguna con efecto no
  autoriza; allowlist de campos de escritura por DTO (anti *mass-assignment*).
- **`[SEG]` RLS en prod (docs/14 §4):** crear `automata_app` no-dueño en Neon,
  `DATABASE_URL` → ese rol, migraciones como dueño aparte, `afirmarRolSeguro`
  **obligatorio y fatal** al abrir el pool; **probar aislamiento contra la URL del
  pooler de Neon** (transaction-mode), no solo local; test anti tabla-futura sin RLS.
- **`[SEG]` Rate limit (docs/14 §3):** elegir store (Upstash/Vercel WAF) y cablear el
  límite por IP/org en el middleware **antes** de exponer endpoints.

**✅ Construido (el WRAPPING, rebanada de motor probada — `core/src/http/`):** el
pipeline de **8 capas** de docs/13 §3 como `withEfecto` (el único camino para un
handler con efecto): `rate → authn(JWT) → método → CSRF → org → [conOrg: membresía
VIVA → assertCan → step-up → validación → handler]`, **fail-closed** en cada capa. Lo
externo (Clerk, rate-limit) entra por PUERTOS → probado end-to-end SIN servicios reales
(`verify:http` 24/24 contra Postgres): 401/429/403-CSRF/405/400/403-rol/403-step-up/
**403-IDOR-cross-org**/402-cuota. Corrección de su revisión adversarial: CSRF fail-closed
(Origin ausente niega), step-up de doble cota (timestamp futuro no evade), `invitar`
pasó a step-up, y guard de "no dejar la org sin admin". **Falta (infra):** los
`route.ts` de Next + config viva de Clerk/Neon/Upstash + el test que escanee `app/api`
para la garantía anti-olvido — el contrato exacto está en
[`core/src/http/adaptador-next.md`](../core/src/http/adaptador-next.md).
**Prueba:** signup real; el test de **aislamiento cross-tenant** (docs/11 §10) —
A no puede leer nada de B — ahora **contra Neon**; `A lee objeto de B por API → 404/403`.

### M3 — Billing + cuotas
**Objetivo:** cobrar y capear.
**Construyes:** Stripe (planes), **verificación de firma de webhooks** (CMA +
Stripe — aquí se saca docs/13 de stub), metering de ejecuciones (holgado, per
(b)). Cambia "sin límite" por el tope.
- **`[SEG]` Topes que CORTAN, no que solo alarman (docs/14 §3):** tabla `subscriptions`
  + helper `assertCuota` (paralelo a `assertCan`); **reserva de cuota con lock** (tx
  atómica: crear automation + reservar espacio + outbox → cierra el TOCTOU de N
  aprobaciones concurrentes); tabla `intakes` + contador mensual para el cap
  **2×espacios/mes**; `task_budget` en CMA + corte de gasto **$10/build**; **tope de
  ejecuciones del Run que corte** (decisión #3 de docs/11 §8) con opción de subir plan;
  **semáforo de builds concurrentes por org**; 10 intakes/org/día.
**Prueba:** un cliente paga; los planes gatean features y cuotas; una ráfaga de
aprobaciones concurrentes **no** revienta la cuota (test del lock).

**✅ Construido (rebanada de motor, probada contra Postgres — `core/src/billing/`):**
el **enforcement de cuota vive en la BD, no en el código de la app** (corrección de
la revisión adversarial: con solo RLS el rol de app podía auto-ascenderse de plan y
resetear sus contadores). Tabla `planes` (límites) + `subscriptions` (plan/estado) +
`uso_periodo` (contadores). Triggers de STOCK (espacios/usuarios) con **advisory lock
por-org** (TOCTOU-safe) y función `app_consumir` (SECURITY DEFINER, solo-suma) para el
FLUJO; el rol de app pierde `UPDATE/DELETE` sobre billing. `verify:cuota:pg` (24/24)
prueba: sin oversell bajo concurrencia real, sin auto-ascenso, sin reset, cancelado no
consume, cross-org aislado, fail-closed, y drift TS↔BD. **Falta cablear** a la capa
HTTP (como `assertCan`) + la integración **Stripe** (checkout/portal/firma) — difieren
al wrapping de Next, igual que Clerk en M2.

**Diferido (con tarea, hallazgos de la revisión M3):**
- **Idempotencia del consumo**: `consumirGeneracion/Ejecucion` no llevan clave; un
  webhook `ready` duplicado (at-least-once, docs/03) doble-cuenta. Contrato de cableado:
  consumir **en la misma tx** que registra la versión/ejecución, keyed por `version_id`
  (`INSERT … ON CONFLICT DO NOTHING`), para que el reintento sea no-op.
- **Periodo vs ciclo de facturación**: hoy es mes-calendario UTC; alinear a
  `subscriptions.periodo_fin` (aniversario de cobro) y a zona MX.
- **Creación org→subscription atómica**: el signup debe crear ambas en una tx (o
  trigger que inserte `subscription` 'base'); el motor ya falla cerrado si falta.

### M4 — Ciclo de vida + robustez + seguridad *(antes de usuarios externos)*
**Objetivo:** ajustes, fallos e insumos hostiles.
**Construyes:** el ciclo de **3 ajustes** ([docs/08](08-ciclo-de-vida.md)),
reparaciones, estados de error, y **el worker de validación de inputs aislado**
([docs/11](11-threat-model.md) §4 y §4bis: límites de recursos, XXE, zip-bomb,
pixel-flood, sobre de lote, **magic bytes** vs content-type spoofing). El bucket
"a revisar".

**✅ Construido (rebanada de motor, probada — `core/src/ciclo/`):** el **ciclo de vida
de 3 ajustes** (`verify:ciclo` 21/21 + `verify:ciclo:pg` 25/25). Modelo **reserva→
confirma**: `iniciarAjuste` **deriva el tipo de la REGRESIÓN** (cambio si el ejemplo
original pasa, reparación si falla, cambio-fail-safe si indeterminado — nunca lo elige
el llamador, corrección ALTA de la revisión), guarda `activa`+cross-org+un-build-en-
vuelo, y crea la versión `building`; `confirmarAjuste` (al `ready`) consume el ajuste solo
para un CAMBIO y quizá congela. Probado: 3 cambios → frozen, **reparación
gratis/ilimitada** (no consume, incluso sobre frozen), congelado voluntario, idempotencia
de confirmar, TOCTOU sin oversell ni spam, y backstops de BD
(`UNIQUE(automatizacion_id,numero)`, `CHECK ajustes_usados<=3`).

**✅ Construido — ventana de 30 días + enforcement del ciclo en la BD** (`verify:ventana:pg`
29/29, docs/06 §4). Un cambio dentro de los **30 días desde la ENTREGA** (columna
`entregada`, sellada **once-only** por trigger al quedar lista la v1) **no gasta uno de
los 3 ajustes**; sí gasta generación. Su revisión adversarial (36 hallazgos, 12 ALTA)
obligó a tres correcciones que van **más allá de la feature**:
1. **`pg_temp` hijack** — `SET search_path = public` no basta: una `TEMP TABLE` homónima
   falseaba **todas** las funciones `SECURITY DEFINER` (ajustes y cuota infinitos,
   kill-switch inerte). Ver el recuadro en [docs/14](14-controles-de-seguridad.md) §4.
2. **La generación se cobra al ARRANCAR el build** (trigger sobre el INSERT de
   `versiones`), no al confirmarlo — mata al «reciclador» (medido: de 40 builds con el
   contador en 0, a corte en el 7º) y a «el que falla mucho». **Corrige docs/06 §4**: un
   build fallido sí consume generación. Además una org **morosa** ya no arranca builds.
3. **El `tipo` se persiste** en `versiones.tipo` al iniciar: antes el llamador podía
   declarar `reparacion` al confirmar y saltarse el enforcement entero.
El rol de app perdió `UPDATE` sobre el ciclo (solo `nombre`/`activa`) y `DELETE` sobre
`automatizaciones`/`versiones`/`ejecuciones`. **Abierto:** las reparaciones siguen sin
tope, y un `confirmarAjuste` que falla deja la versión clavada en `building`.

**✅ Construido (rebanada de motor, probada — `core/src/billing/plan.ts`):** la **rutina
de downgrade** (docs/06 §9, `verify:plan:pg` 22/22). `aplicarDowngrade` (dueño, atómico)
cambia el plan y desactiva el **excedente conservando las más antiguas** (`activa=false`,
solo lectura), tomando el **mismo advisory lock por-org** que el trigger de espacios de M3
— corrección ALTA de la revisión: sin él, un `crearAutomatizacion` concurrente dejaba la
org por encima del límite nuevo (oversell). `reactivar`/`desactivar` (conOrg, acción admin
`gestionar_espacios`): reactivar lo corta el trigger de M3 con `CuotaExcedida` si no hay
espacio (TOCTOU-safe, probado). Los **ajustes gratis de los primeros 30 días** ya no
están diferidos: se construyeron (ver arriba).

**✅ Construido (rebanada de motor, probada — `core/src/entrada/`):** el **gate de
validación de insumos** (dependency-free, `verify:entrada` 34/34). Clasifica en
aceptado / a_revisar (cuarentena, nunca se inventa) / rechazado. Cubre: magic bytes
vs extensión (ejecutable/imagen disfrazada), **XXE/billion-laughs/XInclude** (incl.
sin prólogo, en UTF-16, y **dentro de un XLSX** — corrección de la revisión
adversarial), **ZIP-bomb con inflación ACOTADA de verdad** (`node:zlib` +
`maxOutputLength`, sin fiarse de los tamaños declarados), path traversal (`../`/UNC),
exceso de entradas, ZIP64→cuarentena, pixel-flood (dimensiones sin decodificar), y el
**sobre de lote agregado**. **Diferido (infra):** la **contención por PROCESO** (worker
separado con rlimits de RAM/CPU + timeout duro) envuelve al gate — el algoritmo ya es
acotado, falta el aislamiento de proceso; y **nested-zip / PDF-JS / OLE-macros** se
delegan al extractor no-ejecutante aguas abajo ("parsear nunca ejecutar", docs/11 §4).
- **`[SEG]` Contención del Run (docs/14 §3):** cgroups/límites de memoria/CPU/procesos
  del runner real (el M0 ejecuta sin ellos, aceptable solo aislado).
- **`[SEG]` Kill-switch global** (docs/14 §3): flag que congela builds+ejecuciones ante
  incidente; **probado en staging**.
- **`[SEG]` Runbook concreto** (docs/11 §11): pasos exactos de revocación de sesiones en
  Clerk; inventario y rotación de secretos.
- **Ciclo de vida de cuota (hallazgos M3):** rutina de **downgrade** que ponga
  `activa=false` a las automatizaciones sobrantes al bajar de plan (docs/06 §9 — la
  columna ya existe, falta la lógica); y el modelo de **ajustes** (los primeros 30 días
  y los 3 gratis por automatización de docs/06/[docs/08](08-ciclo-de-vida.md) §7) — hoy
  `consumirGeneracion` cuenta todo build-a-`ready` por igual, sin distinguir nueva vs
  ajuste.
**Prueba:** el **checklist pre-lanzamiento** de docs/11 §10.
**Dependencia dura:** esto DEBE aterrizar **antes** de aceptar archivos de usuarios
externos.

### M5 — Ancho de catálogo + switch multi-input
**Objetivo:** la amplitud del prototipo, y el multi-input.
**Construyes:** más tipos de automatización; el **ruteo multi-input** (XML/PDF/QR —
los rungs gratis, docs/06). El rung de **OCR** (plan Equipo) queda **diferido**
hasta el mini-spike de OCR (`docs/automatizaciones-fichas.md`).
**Prueba:** el catálogo real matchea las 10 del prototipo.

## Fuera de Fase 1 (a propósito)

- **Runner propio + gVisor** — Fase 2 (cuando el volumen o el control lo pidan).
- **El "ask-agent"** (interrogar tu resultado) — diferido; decisión ya tomada
  (riesgo de no-determinismo).
- **El rung de OCR de fotos** — tras el mini-spike.
- Integraciones/OAuth/cron — Fase 3.

## El primer lunes (tareas de M0)

1. Proyecto Neon + schema mínimo (orgs, automations, versions, runs).
2. Environment de CMA para el org hardcodeado, con `packages` (lista blanca) +
   `networking: limited` sin hosts.
3. Función de Inngest: dado un spec → crea sesión CMA → `define_outcome` →
   `waitForEvent`(webhook) → extrae artefacto → guarda en R2.
4. Endpoint de run: ejecuta el artefacto sobre un archivo → produce
   `resultado.json`.
5. Cablear la página de resultado del front a un `vista.json` + `resultado.json`
   reales y renderizar los bloques.
6. Spec de prueba: reutiliza un caso del spike.

**Al final de M0 tienes:** una automatización real, de punta a punta, en tu infra.
Lo más incierto, probado.

## Los 2 residuales de (b) (se cierran en M0/M2)

- **¿El Run corre sin modelo?** → se mide en M0 (fija el costo exacto del Run).
- **Garantía anti-escape del sandbox de CMA** → preguntar a Anthropic antes de M2
  (primer multi-tenant real); mitigación ya adoptada (environment por org).
