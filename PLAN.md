# Plan — Plataforma de automatización por agentes

## 0. Alcance — decidido

**Automatizaciones sin estado, con vista.** Entra un archivo o unos datos, corre
un proceso, sale un resultado que se presenta en pantalla y se puede descargar.

Cada automatización se construye una vez, admite hasta **3 ajustes**, y se
congela. Las reparaciones son gratis e ilimitadas
([docs/08](docs/08-ciclo-de-vida.md)).

**Fuera de alcance, decidido:**

| No entra | Por qué |
|---|---|
| Aplicaciones con datos propios (CRM, inventarios) | Requiere base de datos por cliente, CRUD, esquemas versionados y permisos. Es otro producto — ver [docs/09](docs/09-sistema-de-componentes.md) §6. |
| Integraciones OAuth (Gmail, Sheets, Drive) | Fase 3 |
| Disparadores por cron o webhook | Fase 3 |
| Edición manual del código por el cliente | Nunca — rompe la premisa del producto |
| Progreso en vivo del build | Nunca — la opacidad es intencional |

Esta lista existe para volver a ella cuando aparezca la tentación de ampliar.
El riesgo de este producto no es quedarse corto: es intentar hacer todo y no
hacer bien nada.

## Estado de implementación (2026-07-26)

> Este doc se escribió como **plan**. A esta fecha, el **motor real del MVP
> (M0→M4) ya está construido y probado**: núcleo `core/` framework-agnóstico
> (TS + `.tsx`) más `web/` como cableado de Next 16. Suite de **verify** (22
> scripts) en verde; `typecheck` + `next build` OK; Postgres de prueba en 55432.
> Lo que sigue siendo plan (no construido) va marcado abajo. Esta sección es un
> mapa de "qué del plan ya existe"; el detalle vive en `ARQUITECTURA.md` y los
> docs por pieza.

| Pieza del plan | Estado | Evidencia (archivo:línea) | Prueba |
|---|---|---|---|
| **Separación Build / Run** (§1) | Construido | `core/src/cma/build.ts` (build async), `core/src/run/executor.ts` (Run sin modelos) | `verify:cma`, `verify:sandbox` |
| **Modelos del pipeline** (§2): intake Sonnet 5, planner/builder Opus 4.8 | Construido | `core/src/intake/agent.ts:17`, `core/src/planner/agent.ts:12`, `core/src/cma/build.ts:38` | `verify:intake`, `verify:planner`, `verify:cma` |
| **Verifier con contexto fresco** (§2) vía Outcomes de CMA | Construido | `core/src/cma/build.ts:205-216` (`define_outcome` + rubric), `clasificarSesion` `:130-146` | `verify:cma` |
| **SPEC → rubric** (§2) | Construido | `core/src/cma/build.ts:81-95` (`rubricDesde` desde `criterios_exito`) | `verify:cma` |
| **Environment CMA blindado** (§2): deps pre-horneadas + `networking: limited` sin hosts | Construido | `core/src/cma/build.ts:161-171` | — |
| **Modelo de datos** (§3) | Construido (nombres en español, + tablas de billing/ciclo/ops) | `core/db/schema.sql` (`orgs`, `memberships`, `automatizaciones`, `versiones`, `ejecuciones`) | `verify:pg` |
| **Multitenancy / aislamiento** (implícito en §3, docs/04) | Construido | RLS FORCE + `aislada_por_org` en 7 tablas `core/db/schema.sql:773-798`; roles no-dueños `:14-20`, `:514-520`; `conOrg` `core/src/db/pg.ts` | `verify:pg`, `verify:pgstate:pg` |
| **Cuota por plan** (§3, §6, Fase 1) | Construido, DB-enforced | `planes` `:141-165`, `app_consumir` `:375-402`, triggers `cobrar_build` `:627-679` / `cobrar_ejecucion` `:841-847` | `verify:cuota:pg`, `verify:plan:pg` |
| **`input_manifest`** (§3) | Parcial | El build **produce el manifiesto de entrada** (`Manifiesto`/`EntradaManifiesto` en `core/src/types.ts`, parseado de `manifiesto.json` en `core/src/cma/build.ts`). El **formulario automático** que lo consume vive solo en el prototipo demo (`web/`), aún **no cableado** al motor. (No confundir con `versiones.vista`, que es la vista de SALIDA del planner.) | `verify` (M0) |
| **Ciclo de vida: 3 ajustes + congelado + reparaciones gratis** (§0, §5) | Construido, DB-enforced | `app_consumir_ajuste` `:459-491`, `en_ventana_gratis` `:440-447`, breaker en `cobrar_build` `:638-673`; `core/src/ciclo/servicio.ts` | `verify:ciclo:pg`, `verify:ventana:pg`, `verify:reparaciones:pg` |
| **Guardrails de build** (§5): tope duro, presupuesto | Construido | `MAX_ITERACIONES`/`TIMEOUT_MIN` `core/src/cma/build.ts:39-40`; topes de cuota en BD | `verify:cuota:pg` |
| **Auth + orgs + pipeline HTTP** (Fase 1) | Construido | 8 capas en `core/src/http/pipeline.ts` + `adaptador.ts` + `endpoints.ts`; `core/src/auth/` | `verify:http`, `verify:adaptador:pg`, `verify:rutas` |
| **Camino de Stripe** (Fase 1) | Cableado (motor); requiere llaves | `subscriptions` `:168-178`, `resolver_org_stripe` `:506-509`, `core/src/webhooks/handlers.ts` (guard monótono) | `verify:webhooks:handlers:pg` |
| **Webhooks hacia CMA** (§2, Stack) | Construido | receptor/firma/handlers `core/src/webhooks/`; `webhook_events` `:282-288` | `verify:webhooks`, `verify:webhooks:handlers:pg` |
| **Loop asíncrono de build** (§2, §4): disparo → CMA → cosecha | Construido (outbox + crons) | `core/src/pipeline/disparo.ts` + `cosecha.ts`; `build_pendiente` `:269-277`, `cosecha_pendiente` `:256-263` | `verify:disparo:pg`, `verify:cosecha:pg` |
| **Blob S3 / R2** (Stack) | Construido | `core/src/storage/r2.ts` (S3-compat) | `verify:storage` |
| **Sandbox de ejecución** (§5) | Construido (2 backends) | `LocalPythonExecutor` `core/src/run/executor.ts`; jaula gVisor `core/src/run/container-executor.ts` | `verify:sandbox` |
| **Insumos multi-formato + gate de entrada** (docs/11 §4bis) | Construido | `core/src/entrada/` (validar + `puente.ts` cableado a build/run/upload) | `verify:entrada`, `verify:entrada:gate` |
| **Kill-switch / suspensión / offboarding** (docs/11, docs/14) | Construido | `interruptores` `:196-203`, `suspensiones` `:207-211`, `verificar_freno` `:413-429`; `core/src/ops/killswitch.ts` | `verify:killswitch:pg`, `verify:offboarding:pg` |
| **Observabilidad de costo/incidentes** (Fase 2) | Parcial | `incidentes` `:236-250` + `app_registrar_incidente` `:542-549`; costo reconstruido best-effort `core/src/cma/build.ts:307-320` | `verify:incidentes:pg` |
| **Runner propio y barato para el Run** (Fase 2) | Construido, no desplegado | `core/src/run/container-executor.ts` (gVisor `--runtime=runsc --network none --read-only`) — falta swap en prod | `verify:sandbox` |
| **Cableado a Next 16** (Stack) | Construido | `web/lib/automata/wiring.ts`, rutas `web/app/api/**`, crons `web/vercel.json` | `next build` |

**Sigue siendo PLAN (no construido):**

- **Entrevista de intake en la UI** y **pantalla de aprobación** (§2, Fase 1):
  el agente de intake existe (`core/src/intake/`), pero el flujo de pantallas
  del cliente no está cableado — el front (`web/`) es demo (ver CLAUDE.md).
- **Portafolio con polling y pantalla de Detalle** (§1, Fase 1): son front; el
  prototipo las simula con datos falsos, no consumen el motor.
- **Email "ya está lista" (Resend)** (Stack): no cableado.
- **`nombre_generado` con Haiku** (§3): el esquema usa `automatizaciones.nombre`;
  el nombrado automático con modelo barato no está construido.
- **Fase 3 completa** (cron/webhooks como disparadores del CLIENTE, OAuth): los
  crons que existen (`reaper`/`cosecha`/`disparo`) son **operativos internos**,
  no disparadores del cliente — no cruzan el alcance del MVP.
- **Activación en producción**: credenciales/llaves, alta de webhooks en la
  consola de CMA/Stripe, crons en Vercel Pro y despliegue del runner gVisor
  quedan **deferidos** (necesitan infra, no código).

**Hallazgo de CMA que corrige una asunción previa:** el webhook de CMA es
**thin**. Sus `data.type` reales son `session.status_idled`,
`session.status_terminated` y `session.outcome_evaluation_ended`
(`core/src/cma/build.ts:31-35`); **el éxito NO se sabe por el evento**, solo
re-consultando la sesión (`outcome_evaluations[].result === "satisfied"`, ver
`clasificarSesion` `:130-146`). Esto corrige los nombres inventados
(`session.completed`, etc.) que docs/13 daba por buenos.

## 1. Qué es el producto

El cliente escribe su idea de automatización y da a un botón. **No ve nada más.**
Los agentes trabajan en segundo plano el tiempo que haga falta. Cuando terminan,
la automatización aparece en su **Portafolio**, lista para usar.

La caja es negra a propósito: el cliente no ve agentes, ni código, ni logs, ni
progreso. Solo ve el resultado en su portafolio.

Toda la UI son cuatro pantallas:

1. **Nueva automatización** — el cliente escribe su idea.
2. **Entrevista** — un agente le hace 3–4 preguntas de opción múltiple por
   ronda (máximo dos rondas), generadas a partir de su idea, y le enseña un
   resumen de lo que va a construir. El cliente aprueba o corrige.
3. **Portafolio** — tarjetas: `Generando…` / `Lista` / `Falló`.
4. **Detalle** — abrir una automatización lista, meter sus datos, Ejecutar,
   descargar resultado, historial.

La pantalla 2 es la **única** interacción del cliente en todo el proceso. Dura
dos minutos. Después de aprobar, caja negra hasta que llega el email.

Dos modos de uso, muy distintos, detrás de esas pantallas:

| Modo | Quién | Qué pasa |
|---|---|---|
| **Build** | El cliente envía su idea | Los agentes generan y prueban el código. Lento (minutos), caro, ocurre 1 vez. Invisible. |
| **Run** | El cliente da a "Ejecutar" | Se corre el código ya generado. Rápido (segundos), barato, ocurre N veces. |

**Esta separación es la decisión arquitectónica más importante.** Si cada
ejecución vuelve a invocar agentes, el producto es lento, caro y no
determinista. Los agentes se pagan una vez; las ejecuciones son casi gratis.

### Lo que la opacidad regala y lo que cuesta

Regala mucho: sin progreso en vivo no hace falta SSE, ni streaming de eventos,
ni wizard, ni preview. Un build que tarda 4 minutos o 4 horas se ve igual desde
el frontend — una tarjeta que dice `Generando…`. **El MVP se vuelve más simple,
no más complejo.**

Cuesta una cosa: si la idea del cliente es ambigua, el agente adivina y puedes
entregar la automatización equivocada sin que nadie lo detecte hasta el final.
Mitigación sin romper la opacidad, en §5.

## 2. Arquitectura

```
Cliente (Next.js)
   │
   ├── INTAKE ─► Agente entrevistador (síncrono, ~2 min, Sonnet 5)
   │               ├─ idea en texto libre (1 vez)
   │               ├─ 3-5 preguntas de opción múltiple generadas al vuelo
   │               └─ produce ──► SPEC (JSON estructurado)
   │                                 │
   │                                 ▼  el cliente aprueba el resumen
   │                              [ cola ]
   │                                 │
   ├── BUILD ──► Build Orchestrator ──► Claude Managed Agents  (asíncrono)
   │               (Planner → Builder → Verifier)
   │                                      ├─ sandbox por sesión
   │                                      ├─ escribe código + tests
   │                                      └─ itera contra el rubric del spec
   │                                            │
   │                                            ▼
   │                                    automations (Postgres + blob)
   │                                      código + manifest de inputs
   │
   └── RUN ────► Run Worker ──────────► Sandbox de ejecución
                                          input → código → output
```

### El pipeline de agentes

| Agente | Cuándo | Modelo | Qué produce |
|---|---|---|---|
| **Intake** | Síncrono, con el cliente | `claude-sonnet-5` | El **spec**: objetivo, entradas, salidas, reglas, criterios de éxito. |
| **Planner** | Asíncrono, al aprobar | `claude-opus-4-8` | Descomposición en tareas + el rubric de verificación. |
| **Builder** | Asíncrono | `claude-opus-4-8`, effort `high` | Código + tests, dentro del sandbox de CMA. |
| **Verifier** | Asíncrono | `claude-opus-4-8` | Corre el rubric contra el resultado real. Si falla, devuelve al Builder. |

**El Verifier con contexto fresco es lo que hace fiable el sistema.** Un agente
que revisa su propio trabajo se autoaprueba; uno separado, que solo ve el spec
y el resultado, no. Esto ya viene construido en los *Outcomes* de CMA: defines
el rubric y un grader independiente itera hasta cumplirlo.

### El SPEC: el contrato entre entrevista y construcción

La entrevista **no** entrega una transcripción al planner — entrega un objeto
estructurado. Es la pieza que hace que todo lo demás sea verificable:

```jsonc
{
  "objetivo": "Consolidar facturas mensuales en un reporte por proveedor",
  "entradas":  [{ "tipo": "archivo", "formato": "xlsx", "descripcion": "..." }],
  "salidas":   [{ "tipo": "archivo", "formato": "xlsx" }],
  "reglas":    ["Ignorar facturas canceladas", "Agrupar por RFC"],
  "criterios_exito": [            // ← esto se convierte en el rubric
    "El reporte tiene una fila por proveedor",
    "La suma total coincide con la suma de las facturas de entrada"
  ],
  "ambiguedades_restantes": ["No se especificó qué hacer con moneda extranjera"]
}
```

`criterios_exito` es lo más importante del objeto: es lo que el Verifier usa
para decidir si la automatización está bien. Si la entrevista no consigue
sacar criterios verificables, no hay forma de saber si el build funcionó.

### Entrevista: opción múltiple, no chat abierto

**El formato es: texto libre una vez al principio, luego rondas de preguntas de
opción múltiple.** El cliente escribe su idea en un textarea, el agente lee eso
y genera 3–4 preguntas con opciones; el cliente elige. Una o dos rondas, y listo.

No es un formulario fijo: **las preguntas y las opciones las genera el agente**
a partir de lo que el cliente escribió. Dos clientes distintos ven preguntas
distintas.

Por qué es mejor que el chat abierto:

- **Reconocer es más fácil que redactar.** El cliente no tiene que encontrar las
  palabras para describir algo técnico que quizá no sabe nombrar. Solo reconoce
  cuál de las opciones se parece a lo suyo.
- **Las opciones le enseñan qué es posible.** Este es el punto que se subestima:
  el cliente no sabe qué puede hacer una automatización. Ver "¿quieres que corra
  sola cada mañana sin que hagas nada?" como opción le revela una capacidad que
  no habría pedido. **La entrevista es tu principal superficie de descubrimiento
  del producto**, no solo de captura de requisitos.
- **Las respuestas ya vienen estructuradas.** No hay que interpretar prosa para
  llenar el spec. Menos ambigüedad, menos tokens, menos error.
- **Es rápido.** Cuatro clics contra cuatro párrafos escritos.

### Regla de oro: preguntar por el negocio, nunca por la técnica

**El cliente no sabe programar y no tiene por qué.** Toda pregunta debe poder
contestarla alguien que conoce su trabajo pero nunca ha visto una línea de
código. Si una pregunta obliga al cliente a tomar una decisión técnica, la
pregunta está mal escrita — esa decisión le toca al Planner, deducida de las
respuestas de negocio.

| ❌ Nunca preguntar así | ✅ Preguntar así |
|---|---|
| "¿Corre por cron o por webhook?" | "¿Esto lo haces todos los días a la misma hora, o cuando te llega algo?" |
| "¿Qué formato de salida: CSV, XLSX o JSON?" | "¿En qué te gustaría recibir el resultado — una hoja de cálculo, un documento, un correo?" |
| "¿Necesitas validación de esquema?" | "¿Qué pasa si llega una factura con datos raros o incompletos? ¿La saltamos, o prefieres que te avise?" |
| "¿Procesamiento por lotes o en streaming?" | "¿Los archivos llegan de golpe todos juntos, o de uno en uno a lo largo del día?" |

Fíjate que la columna derecha le saca **la misma información técnica** — pero el
cliente solo está describiendo su trabajo. La traducción de "cuando me llega
algo" a *webhook* es trabajo del Planner, no del cliente.

Anatomía de cada pregunta:

- 2–4 opciones, nunca más.
- Cada opción con **una línea que describe qué pasaría en su mundo**, no la
  consecuencia técnica. "Reviso yo antes de enviarlo" es buena; "requiere paso
  de aprobación manual en el flujo" es mala.
- Cero jerga: nada de API, formato, schema, integración, batch, endpoint.
- Si hay una opción claramente recomendable, va primera y marcada.
- **Siempre una escapatoria de texto libre** ("Otro: …" / "Ninguna de estas").
  Sirve para dos cosas: que el cliente cuyo caso no encaja no quede atrapado
  eligiendo algo falso, y que pueda decir "te estás yendo por otro lado" y
  corregir el rumbo. Sin ella, el spec se envenena en silencio.
- 3–4 preguntas por pantalla, no una a la vez. Se responden de un vistazo.

**Prueba para validar una pregunta antes de mandarla:** ¿podría contestarla la
persona que hace este proceso hoy a mano? Si no, está mal escrita.

Dos reglas más:

1. **Adaptativas, no fijas.** El techo son 2 rondas de 3–4 preguntas (máximo
   8; lo normal, 3–5 — [docs/10](docs/10-intake.md) §2). Si con 3 preguntas el
   agente ya puede escribir el spec, cierra. Preguntar de más para "llenar la
   ronda" hace que el producto se sienta burocrático.
2. **Pide un archivo de ejemplo, no lo describas.** Un campo "sube una factura
   de ejemplo" vale más que cinco preguntas sobre el formato, y ese archivo
   entra al build como caso de prueba real.

### Pantalla de aprobación

Al terminar las preguntas, el agente enseña el spec en lenguaje natural: "voy a
construir esto, con estas entradas, y estará bien si se cumple esto". El cliente
aprueba o corrige. **Es lo más barato que puedes hacer para no construir la cosa
equivocada**, y ocurre *antes* del build, así que no rompe la opacidad.

### Por qué Claude Managed Agents (CMA)

El mayor riesgo técnico de este producto es **ejecutar código generado por IA
de forma segura**. Normalmente eso significa montar tu propia infra de sandboxes
(Firecracker, gVisor, E2B) — semanas de trabajo y la parte más fácil de romper.

Managed Agents resuelve las dos cosas de golpe:

- Anthropic corre el **loop del agente** (no escribes el bucle).
- Anthropic provisiona un **contenedor aislado por sesión** donde el agente
  ejecuta bash, escribe archivos y corre código.
- Los archivos entran como `resources` y salen por `/mnt/session/outputs/`.
- **Outcomes**: defines un rubric ("el CSV debe tener columna `precio` numérica")
  y un grader independiente itera hasta que se cumple. Esto es exactamente el
  bucle "planea → programa → verifica" que queremos, ya construido.

Trade-off honesto: es beta, y para el modo **Run** probablemente quieras salir
de CMA (una sesión de agente por ejecución es caro y lento). Ver §4.

### Stack

| Capa | Elección | Por qué |
|---|---|---|
| Front + API | **Next.js 15 (App Router), TypeScript** | Una sola base de código, deploy trivial. Sin SSE: el portafolio hace polling cada 10s. |
| Agentes | **`@anthropic-ai/sdk` — Managed Agents (beta)** | Sandbox + loop gestionados. |
| Modelo (build) | **`claude-opus-4-8`**, effort `high` | El agente que escribe código es el eslabón crítico. |
| Modelo (auxiliares) | `claude-sonnet-5` | Clasificar, resumir, nombrar. |
| DB | **Postgres** (Neon o Supabase) | Relacional, transaccional, barato. |
| Blob | S3 / R2 | Archivos del cliente y artefactos. |
| Cola | **Inngest** (o Postgres + worker) | Los builds duran minutos u horas y sobreviven deploys. Aquí no se ahorra. |
| Notificación | Email (Resend) | El único canal de "ya está lista". |
| Auth + billing | Clerk/Auth.js + Stripe | Estándar, no reinventar. |

**Actualización (Stack, construido):** el cableado real corre sobre **Next.js
16.2.10** (`web/package.json:19`), no 15 — hay cambios de fondo en 16 (params
como Promise, etc.), ver `web/CLAUDE.md`/`web/AGENTS.md`. Para la **cola** se
tomó la opción "**Postgres + worker**" (outbox `build_pendiente`/`cosecha_pendiente`
en `core/db/schema.sql:256-277` drenado por crons de Vercel `web/vercel.json`),
no Inngest. Auth es **Clerk**; el blob es **R2** (`core/src/storage/r2.ts`).

**Webhooks, no polling, hacia CMA.** Registra `session.status_idled` y
`session.status_terminated` para que Anthropic te avise cuando el build termina,
en vez de tener un worker esperando horas con una conexión abierta.

### Costo de modelos (por millón de tokens)

| Modelo | Input | Output |
|---|---|---|
| Opus 4.8 | $5 | $25 |
| Sonnet 5 | $3 ($2 intro hasta 2026-08-31) | $15 ($10 intro) |
| Haiku 4.5 | $1 | $5 |

Un build serio (agente iterando con tests) puede costar **$1–5 en tokens**.
Eso define el pricing: cobrar por automatización creada, no por ejecución.

## 3. Modelo de datos (mínimo)

```
users / organizations       plan, cuota_automatizaciones, usadas
intakes           id, org_id, transcripción, spec (JSON), aprobado_at
automations       id, org_id, intake_id, nombre_generado, status
                  status: queued | building | ready | failed
                  (la entrevista vive en intakes — docs/10)
                  current_version_id
versions          id, automation_id, código, input_manifest (JSON Schema),
                  rubric, build_session_id, tests_passed
runs              id, version_id, inputs, outputs, status, logs, duración, costo
```

`status` es lo único que el portafolio consulta. `nombre_generado` lo escribe un
agente barato (Haiku) a partir del prompt, para que la tarjeta diga
"Limpieza de facturas mensuales" y no las primeras 40 letras del texto.

**La cuota se reserva al aprobar la entrevista** y cuenta espacios
comprometidos (`queued`+`building`+`ready`); `failed` y `archived` liberan
([docs/10](docs/10-intake.md) §9). Un build fallido no consume cuota — si no,
el cliente paga por algo que no recibió.

**Actualización (motor construido):** hay **dos cuotas distintas** y el enforcement
vive en la BD, no en el código de la app. (1) **Espacios** (stock): las
automatizaciones `activa` cuentan contra el plan (trigger `verificar_cuota_espacio`,
`core/db/schema.sql:715-731`). (2) **Generaciones** (flujo): se cobra **una
generación al ARRANCAR el build**, no al aprobar la entrevista ni al confirmar
(trigger `cobrar_build` → `app_consumir`, `core/db/schema.sql:611-679`). Por esa
decisión ("el que falla mucho", docs/06 §3), **un build que arranca y falla SÍ
consume la generación de flujo** — al revés de lo que dice el párrafo de arriba;
lo que no consume el ajuste del ciclo es un build fallido (`fallarAjuste`,
`core/src/ciclo/servicio.ts`).

`input_manifest` es la pieza que hace todo funcionar: el agente de build declara
qué necesita el proceso (un CSV con estas columnas, un PDF, un texto), y el
frontend **genera el formulario de ejecución automáticamente** a partir de ese
schema. El cliente nunca ve código.

## 4. Fases

**Actualización (2026-07-26):** este apartado se escribió a futuro; el estado
real está en "Estado de implementación" arriba. En corto: **Fase 0 (spike):
hecha** (3/3, ~$1.8/build — `spike/RESULTADO.md`). **Fase 1 (MVP): el motor está
construido y probado** (aislamiento, cuota, ciclo, kill-switch, pipeline HTTP,
data plane, cosecha, upload); falta el **cableado de las pantallas del cliente**
(intake/aprobación/portafolio/detalle) y el email. **Fase 2: adelantada en
parte** — el runner gVisor y la tabla de incidentes ya existen, sin desplegar.

### Fase 0 — Spike técnico (3–5 días) · antes de escribir producto
Un script, sin UI. Objetivo: probar que el núcleo funciona.
- Crear agente + environment CMA; abrir sesión.
- Subir un CSV, pedir "límpialo y dame totales por categoría".
- Definir un outcome con rubric; ver el bucle grade→revise.
- Recuperar el `.py` generado y el CSV de salida.
- **Medir**: tiempo, tokens, costo, tasa de éxito en 10 procesos reales.

Si aquí el costo o la fiabilidad no cuadran, se replantea antes de invertir.

### Fase 1 — MVP vendible (3–5 semanas)
- Auth, orgs, Stripe con planes por cuota de automatizaciones.
- **Entrevista**: chat con el agente de intake → spec estructurado → pantalla de
  aprobación → encola el build. El cliente vuelve al portafolio.
- **Worker de build**: Planner arma el rubric desde `criterios_exito`, crea la
  sesión CMA con el outcome, espera el webhook, extrae código +
  `input_manifest`, marca `ready`, manda email.
- **Portafolio**: grid de tarjetas con polling cada 10s.
- **Detalle**: formulario generado del `input_manifest`, Ejecutar, descargar,
  historial de runs.
- Guardrails: `task_budget`, timeout duro por build, cuota por plan.

**Fuera de alcance en el MVP** (decidido): integraciones OAuth, cron/webhooks,
multi-paso visual, edición manual del código, progreso en vivo.

### Fase 2 — Fiabilidad y economía (post-MVP)
- Sacar el modo **Run** de CMA a un runner propio y barato (contenedor efímero
  con el código y sus deps). Es donde está el margen.
- Versionado y rollback de automatizaciones.
- Observabilidad de costo por org.

### Fase 3 — Expansión
- Cron y webhooks como disparadores.
- Integraciones OAuth (Gmail, Sheets, Drive) vía MCP + vaults de CMA — el vault
  sustituye el secreto en el egress, así que la credencial nunca entra al
  sandbox. Esto es lo que hace viable venderlo a empresas.

## 5. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Seguridad del código generado** | Sandbox de CMA + networking `limited` en el environment. Nunca ejecutar en tu infra sin aislar. |
| **Costo de build impredecible** | `output_config.task_budget` (mínimo 20k tokens) + tope duro de `max_tokens` + límite de iteraciones del outcome. |
| **La idea del cliente es ambigua** | Ver abajo — es el riesgo #1 de un flujo opaco. |
| **CMA es beta** | Aislar todo detrás de una interfaz `AgentRunner`. Si hay que cambiar a sandboxes propios, se toca un módulo. |
| **El cliente no confía en el resultado** | Al abrir una automatización lista, mostrar el ejemplo con el que se validó. La confianza se gana enseñando que ya funcionó una vez. |

### El riesgo #1: la calidad del spec

Con el agente de intake, la ambigüedad deja de ser el riesgo — pasa a serlo la
**calidad del spec**. Una entrevista que produce criterios vagos ("que quede
bien") no le da al Verifier nada contra qué medir, y el build se autoaprueba
aunque esté mal. Tres defensas:

1. **Instrucción explícita al agente de intake**: no cierres la entrevista sin
   al menos dos criterios de éxito comprobables por una máquina.
2. **Pantalla de aprobación** — descrita en §2. El cliente ve el spec antes de
   que arranque nada.
3. **Botón "Pedir ajuste"** en la automatización lista: el cliente describe qué
   está mal, se relanza el build sobre el mismo spec corregido, sin consumir
   cuota. Convierte un fallo en una iteración barata.

   **Actualización (motor construido):** "sin consumir cuota" aplica **solo a las
   reparaciones**. El motor **deriva el tipo de la regresión, no del llamador**
   (`iniciarAjuste` en `core/src/ciclo/servicio.ts`): una **reparación** (algo que
   se rompió) es gratis e ilimitada, acotada por un **circuit breaker** que
   engancha un latch persistente si una automatización se repara en bucle
   (`cobrar_build`, `core/db/schema.sql:638-673`); un **cambio** (funcionalidad
   nueva) sí consume 1 de los 3 ajustes, salvo dentro de la **ventana de 30 días**
   desde la entrega (`app_consumir_ajuste` + `en_ventana_gratis`,
   `core/db/schema.sql:440-491`).

Las tres van en el MVP. Son baratas y son la diferencia entre un producto que
funciona y uno que entrega basura convincente.

### Sobre "minutos, horas o días"

Técnicamente un build son **minutos**, no días. Que tarde días solo tiene
sentido si hay una persona revisando antes de entregar — y eso cambia el
negocio: dejas de vender software y empiezas a vender un servicio con margen
por hora humana. **Recomiendo no meter humano en el loop en el MVP.** Entrega
en minutos, y si un build necesita revisión, márcalo `failed` y ofrece el
reintento gratis. Si más adelante quieres un tier premium "revisado por
experto", eso ya es un plan de precio distinto, no una fase técnica.

## 6. Lo primero que hay que decidir

1. ¿Qué 3 procesos reales van a ser los casos de prueba de la Fase 0?
   (Sin esto, el spike no prueba nada.)
2. Planes y cuota: ¿cuántas automatizaciones por mes en cada tier?
   Con un costo de $1–5 por build, un plan de 10 automatizaciones/mes tiene un
   costo variable de $10–50 — eso pone el piso del precio.
