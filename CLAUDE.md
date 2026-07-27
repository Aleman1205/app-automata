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

## Estado de implementación (2026-07-26)

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
| Ciclo de vida (docs/08) | **Construido** | `core/src/ciclo/servicio.ts:190-228` (`confirmarAjuste` con SAVEPOINT `tras_entrega` = entrega garantizada; 3 ajustes + congelado; circuit breaker con latch) | `verify:ciclo:pg`, `verify:ventana:pg`, `verify:reparaciones:pg` |
| Kill-switch / offboarding (docs/04, 05) | **Construido** | `core/src/ops/killswitch.ts:54-87` (`verificarFreno`, `suspenderOrg`, `purgarOrg` owner-only) + triggers DB | `verify:killswitch:pg`, `verify:offboarding:pg` |
| Intake / componentes (docs/09, 10) | **Construido** (núcleo determinista) | `core/src/intake/` (adapter + validator), `core/src/vista/resolver.ts` | `verify:intake`, `verify:planner` |
| Entrada multi-formato / gate (docs/11 §4bis) | **Construido** | `core/src/entrada/` (validador XXE/zip-bomb/pixel-flood/spoofing + `puente.ts` cableado a build/run/upload) | `verify:entrada`, `verify:entrada:gate` |
| Webhooks + cosecha (docs/03, 13) | **Construido** | `core/src/webhooks/` (firma HMAC, dedupe, handlers), `core/src/pipeline/cosecha.ts` + `disparo.ts` | `verify:webhooks`, `verify:webhooks:handlers:pg`, `verify:cosecha:pg`, `verify:disparo:pg` |
| Observabilidad / incidentes (docs/05) | **Construido** | `core/src/ops/incidentes.ts` (append-only, SD, reaper emite incidentes) | `verify:incidentes:pg` |
| Data plane: storage + CMA | **Construido** | `core/src/storage/r2.ts` (R2/S3-compat, `existe()`), `core/src/cma/build.ts` (arrancar/cosechar + clasificarSesion) | `verify:storage`, `verify:cma` |
| Runner sandbox (docs/02, 11) | **Fase 0 probada; gVisor cableado** | `core/src/run/executor.ts` (`LocalPythonExecutor` endurecido: env allowlist, ulimit, kill de grupo) probado; `core/src/run/container-executor.ts:12-97` (jaula gVisor `runsc`, `--network none`, `--read-only`, `--cap-drop ALL`, `--pids-limit`) **cableado, se prueba al desplegar** | `verify:sandbox` |

**Marco de pruebas:** 28 scripts `verify:*` en `core/package.json:28-55` (unit +
contra Postgres real, sufijo `:pg`). Por el reporte de Fase 1 corren **en verde**;
`tsc --noEmit` y `next build` OK. La BD de pruebas es un Postgres temporal en el
puerto **55432**.

**Hallazgo que corrige el diseño previo:** el webhook de CMA es *thin* — sus
`data.type` reales **accionables** son `session.status_idled` (→ encola cosecha) y
`session.status_terminated` (→ falla); el resto (`session.outcome_evaluation_ended`,
etc.) es informativo. El ÉXITO de un build sólo se sabe **re-consultando la
sesión**, no por el evento. Esto corrige los nombres inventados
(`session.completed`, etc.) que docs/13 daba por buenos (ver corrección en línea
en el índice, abajo).

**Falta para producción (deferido, necesita llaves/infra, NO código):**
credenciales en `.env.local`/Vercel/Neon; alta de webhooks en las consolas de
CMA y Stripe; crons en Vercel Pro; desplegar el runner gVisor y cambiar
`LocalPythonExecutor` → `ContainerRunExecutor`. El flujo de subida ya existe
(`POST /orgs/:orgId/ejemplo`).

## Estado actual

| Parte | Estado |
|---|---|
| Planeación de arquitectura | **Completa** — 13 documentos, 2 curtidos con crítica adversarial |
| Prototipo del front | **Funcional** — solo apariencia, datos falsos, para inversionistas |
| Spike (prueba técnica) | **Corrido ✓ — 3/3 casos, ~$1.8/build real** (ver `spike/RESULTADO.md`) |
| Backend / producto real | **Actualización (2026-07-26): motor de Fase 1 CONSTRUIDO** — `core/` (TS+tsx, framework-agnóstico) + `web/` (wiring Next 16); 28 `verify:*` en verde, typecheck + `next build` OK. Detalle en la sección "Estado de implementación". Plan original en `docs/plan-fase-1.md`. Falta activar (llaves/infra), no código. |

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

**Actualización:** con el spike resuelto (#1 histórico) y el riesgo técnico del
backend cerrado en código (#3), el riesgo abierto que **no se resuelve con más
papel ni con más código** es el **#2: clientes**. Más planeación de arquitectura
—o más motor— es, a estas alturas, procrastinar el #2.

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
| 15 | **Motor implementado** | **NUEVO (2026-07-26):** catálogo maestro de lo construido en Fase 1 — módulos de `core/`, modelo de seguridad en la BD, loop async de build de punta a punta, la suite de 28 `verify:*`, rutas/crons y el checklist para activar en producción |

(No hay docs/12; el 13 se numeró así a propósito.)

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
# ...son 28 scripts `verify:*` en core/package.json:28-55 (sufijo :pg = con BD)
```

- **Front, spike y motor son proyectos separados**: front usa `pnpm` en `web/`;
  el spike usa `npm` en la raíz; el motor usa `npm` en `core/`. No mezclar.
- Los `verify:*` con sufijo **`:pg`** necesitan un Postgres alcanzable (en las
  pruebas de Fase 1 se usó uno temporal en el puerto **55432**); los demás corren
  sin BD.
- El spike usa **Managed Agents (beta)** — si da error de acceso, hay que
  activarlo en la cuenta de Anthropic. Aparta ~$5 de crédito por corrida.

## Convenciones

- **Idioma de TODA la UI: español de México, tuteo, cero jerga técnica.** El
  cliente del producto no programa. Nada de "webhook", "API", "deploy".
- **El front es 100% demo:** datos falsos en `web/lib/datos.ts`, sin backend.
  Formularios y botones animan pero no guardan ni envían nada.
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

## Datos de demostración del prototipo

El front simula el negocio **"Hotel Vitrales"** (plan Equipo): equipo de 5
personas (Ana Rivera = admin/usuaria actual; Luis, Carmen, Jorge = operadores;
Roberto = invitación pendiente). El caso del spike es un reporte de popularidad
de productos de restaurante (archivo real anonimizado → `spike/generar-gastos.js`).
