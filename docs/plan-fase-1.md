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
**Prueba:** la integración más novedosa funciona en tu sistema. **Cierra el
residual #2 de (b)** (¿el Run corre sin modelo? → aquí se mide).
**Difieres:** auth, multi-tenant, billing.

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
**Prueba:** signup real; el test de **aislamiento cross-tenant** (docs/11 §10) —
A no puede leer nada de B.

### M3 — Billing + cuotas
**Objetivo:** cobrar y capear.
**Construyes:** Stripe (planes), **verificación de firma de webhooks** (CMA +
Stripe — aquí se saca docs/13 de stub), metering de ejecuciones (holgado, per
(b)). Cambia "sin límite" por el tope.
**Prueba:** un cliente paga; los planes gatean features y cuotas.

### M4 — Ciclo de vida + robustez + seguridad *(antes de usuarios externos)*
**Objetivo:** ajustes, fallos e insumos hostiles.
**Construyes:** el ciclo de **3 ajustes** ([docs/08](08-ciclo-de-vida.md)),
reparaciones, estados de error, y **el worker de validación de inputs aislado**
([docs/11](11-threat-model.md) §4 y §4bis: límites de recursos, XXE, zip-bomb,
pixel-flood, sobre de lote). El bucket "a revisar".
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
