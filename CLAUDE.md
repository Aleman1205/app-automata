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

## Estado actual

| Parte | Estado |
|---|---|
| Planeación de arquitectura | **Completa** — 13 documentos, 2 curtidos con crítica adversarial |
| Prototipo del front | **Funcional** — solo apariencia, datos falsos, para inversionistas |
| Spike (prueba técnica) | **Corrido ✓ — 3/3 casos, ~$1.8/build real** (ver `spike/RESULTADO.md`) |
| Backend / producto real | **No existe todavía** |

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

Más planeación de arquitectura es, a estas alturas, procrastinar el #2.

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
| 13 | Auth y webhooks | stub: MFA, 2 roles, firma de webhooks (pendiente de diseñar) |

(No hay docs/12; el 13 se numeró así a propósito.)

## Decisiones clave tomadas (para no re-litigar)

- **Build vs Run separados.** El Build (agentes, caro, 1 vez) y el Run
  (ejecutar código, barato, N veces) son distintos. El Run **no usa modelos**.
- **Managed Agents (Anthropic)** para el Build en el MVP; runner propio en Fase 2.
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

## Cómo correr

```bash
# Front (prototipo)
cd web && pnpm install && pnpm dev        # → localhost:3000

# Spike (prueba técnica) — desde la raíz
npm install
npm run datos                              # genera/regenera datos de prueba
export ANTHROPIC_API_KEY=sk-ant-...
npm run spike                              # corre el caso (Vitrales sintético)
```

- **Front y spike son proyectos separados**: front usa `pnpm` en `web/`; el
  spike usa `npm` en la raíz. No mezclar.
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
