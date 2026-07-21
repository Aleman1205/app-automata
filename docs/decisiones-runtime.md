# Decisiones de runtime (resuelve docs/11 §12)

> Las 3 decisiones que el red-team elevó a "necesitan decisión de negocio"
> ([docs/11](11-threat-model.md) §12), con **recomendación decidida** para cada
> una. Las tres cuelgan de hechos de CMA que hay que **confirmar con su doc**
> (marcados ⚠️). Fecha: 2026-07-20.

---

## Decisión #1 — Aislamiento: ¿gVisor antes del primer cliente?

**Recomendación: la pregunta se disuelve en el MVP, y se vuelve regla en Fase 2.**

En el MVP, **Build y Run viven en CMA** (Anthropic). Eso significa que **tú no
operas el contenedor** — el aislamiento cross-tenant es de *su* sandbox, no de tu
runtime. No construyes gVisor ni runtime endurecido: **heredas el suyo.**

- **MVP:** no gastes esfuerzo en runtime de contenedor. Tu control portante para
  el activo #1 pasa a ser *"confiar en el sandbox de CMA + validar pertenencia
  org↔artefacto dentro de tu capa"* ([docs/04](04-multitenancy.md) §6).
- **Fase 2 (runner propio):** **gVisor (`runsc`) desde el día 1 de ese runner —
  no negociable.** Nunca lances un runner propio con solo hardening estándar
  (no-root/sin-red/efímero); el escape es el eslabón portante del cross-tenant.

⚠️ **Confirmar con Anthropic:** que el sandbox de CMA sea aislamiento fuerte
(clase gVisor/microVM). Tu activo #1 se está apoyando en él — hay que saberlo por
escrito, no asumirlo.

**Impacto en (c):** el MVP no presupuesta trabajo de runtime de contenedor. Fase 2
presupuesta gVisor desde el inicio del runner.

---

## Decisión #2 — ¿El build puede vivir en CMA con egress seguro?

**Este es el cuello de botella real. Recomendación en orden de preferencia:**

1. **Pre-hornear la lista blanca en la imagen del environment → build sin red.**
   Si los paquetes aprobados vienen **preinstalados** en el environment de CMA, el
   build **no necesita `pip` en vivo**, y se corre con **red DESHABILITADA**. Eso
   **disuelve** el problema de exfiltración-en-build de raíz. El spike ya
   configura la red del environment (`networking: { type: "unrestricted" }`) — o
   sea, es **configurable**; falta confirmar que existe el modo "none" y que se
   pueden hornear deps en la imagen. **Esta es la opción preferida.**
2. **Si el build sí necesita `pip` vivo:** egress restringido a un **mirror
   privado de PyPI + DNS fijado** (solo la lista blanca), *si CMA lo permite*.
3. **Si ninguna:** **aceptar por escrito el riesgo de exfil-en-build para el
   MVP** — es un riesgo acotado porque **durante el build solo hay datos de UN
   tenant** (el propio cliente) y el Verifier de contexto fresco atrapa la
   desviación de resultado — y **mover el build a runner propio en Fase 2.**

⚠️ **Confirmar con la doc de CMA (3 preguntas):**
- ¿Existe modo de red **"none"** para el environment?
- ¿Se pueden crear **imágenes con paquetes preinstalados** (para no necesitar pip)?
- Si no, ¿permite **egress restringido a un mirror + DNS fijado**?

**Impacto en (c):** la opción 1 mantiene el MVP simple (sin infra de red propia).
La 3 adelanta el runner propio. **(c) no se puede secuenciar sin esta respuesta.**

---

## Decisión #3 — Cuota de ejecuciones por plan que CORTE

**Recomendación: sí, tope duro que corta — pero los números del doc estaban mal.**

Sí es obligatorio un tope que **corte** (no solo alarme) mientras el Run viva en
CMA. **Pero** los números sugeridos en §12 (Base 500 / Pro 2,000 / Equipo 10,000)
**asumían el runner barato de Fase 2**; a **~$0.30/ejecución de CMA** te quiebran.

Recálculo para la era-CMA (tope = **backstop de abuso**, no límite de uso normal):

| Plan | Precio | Tope/mes | Costo Run al tope | Uso normal esperado |
|---|---|---|---|---|
| Base | $499 MXN (~$27) | **50** | ~$15 | 10–15 (procesos mensuales) |
| Pro | $999 (~$54) | **100** | ~$30 | 20–40 |
| Equipo | $1,999 (~$108) | **200** | ~$60 | 40–80 |

- Los topes son **~50-56% del ingreso al máximo absoluto** — un abusador queda
  acotado, no te quiebra. El **uso normal** (un cierre mensual, unas corridas por
  automatización) **ni los roza.**
- **Corta en el tope** con *"sube de plan o espera al reinicio"*; **nunca sigas
  cobrándote** en silencio.
- **Fase 2 (Run propio, ~$0):** los topes suben drásticamente o pasan a "uso
  justo". Estos números bajos son un **artefacto de la era-CMA.**

**Insight de roadmap:** que $0.30/ejecución deje las tarifas bajas tan apretadas
**es en sí un argumento para mover el Run fuera de CMA antes de lo planeado.**
#3 no es solo un cap — es una señal de que el runner propio (Fase 2) tiene más
urgencia económica de la que parecía.

**Impacto en (c) y docs/06:** el pricing debe cambiar **"ejecuciones sin límite"**
por estos topes; el **metering que corta** es código de Fase 1 (no opcional).

---

## Lo que queda antes de cerrar (b) del todo

Las 3 recomendaciones están tomadas, pero **#1 y #2 tienen un ⚠️ de hechos de
CMA** que conviene confirmar leyendo su doc antes de comprometer el plan:
1. ¿El sandbox de CMA es aislamiento fuerte? (#1)
2. ¿Modo de red "none" + imágenes con deps preinstaladas? (#2, la preferida)
3. ¿Egress restringido a mirror + DNS fijado? (#2, el plan B)

Con esas 3 respuestas, (b) queda cerrado sin asteriscos y (c) se puede secuenciar.
