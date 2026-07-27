# Decisiones de runtime (resuelve docs/11 §12)

> Las 3 decisiones que el red-team elevó a "necesitan decisión de negocio"
> ([docs/11](11-threat-model.md) §12), con **recomendación decidida**. Los hechos
> de CMA se **confirmaron contra la doc oficial** (2026-07-21). Quedan 2
> residuales que necesitan pregunta directa a Anthropic (no bloquean el plan).

---

## Estado de implementación (2026-07-26)

> Fase 1 construida (motor real en `core/`, framework-agnóstico). Esto traduce las
> 3 decisiones de abajo a código real, con `archivo:línea` y el `verify` que lo
> prueba. Lo que sigue siendo plan (no desplegado) se marca como tal.

**Decisión del runner del Run — RESUELTA: CONTENEDOR gVISOR self-hosted (a5-Fase 2),
con el puente Fase-0 como interino.** Ya no es "CMA o gVisor algún día": el objetivo
del Run es runner propio en contenedor gVisor, y mientras se despliega la infra corre
un puente de bajo costo.

- **Jaula gVisor (objetivo) — CABLEADA en código, NO desplegada.**
  `ContainerRunExecutor` (`core/src/run/container-executor.ts:64`) implementa el
  MISMO puerto `RunExecutor` que el puente, así que se intercambia sin tocar el
  pipeline. Flags de la jaula (`container-executor.ts:87-102`): `--runtime runsc`
  (gVisor; default en `:40`), `--network none` (`:91`), `--read-only` (`:92`),
  `--user 65534:65534` (`:93`), `--cap-drop ALL` + `--security-opt no-new-privileges`
  (`:94`), `--pids-limit` (`:95`), `--memory`/`--cpus` (`:96-97`). Costo de tokens $0
  porque el Run no usa modelo (`:116`). **Requiere host con Docker/nerdctl + runsc; no
  corre en serverless** (`:22-25`) → se ejercita al desplegar el runner. No está
  cableado a ningún pipeline todavía (el swap es parte de la activación en producción).
- **Puente Fase-0 (interino) — construido y probado.** `LocalPythonExecutor`
  (`core/src/run/executor.ts:121`) NO es jaula real: red/FS/kernel siguen abiertos por
  diseño (`executor.ts:11-19`) y por eso hay guard anti-prod que lanza si
  `NODE_ENV=production` sin `permitirEnProduccion` (`:127-129`). Es contención de bajo
  costo para la ventana interna/M0: env ALLOWLIST anti-fuga de secretos (`:61-78`),
  `ulimit -t/-f` por-proceso (`:87`), kill del GRUPO al timeout (`:97-100`), lectura
  acotada del resultado anti-OOM (`:109`). Prueba: `verify:sandbox`
  (`core/scripts/verify-run-sandbox.ts`) con fixtures hostiles — fuga de secretos,
  resultado gigante, happy path y timeout. **El pipeline hoy usa el puente**
  (`run-m0.ts:47`).

**Decisión #2 (egress del build) — IMPLEMENTADA tal cual.** El build vive en CMA sin
runner propio: `CmaBuildClient` (`core/src/cma/build.ts:148`) crea el environment con
deps pre-horneadas (`packages.pip`, `build.ts:165`) y `networking: { type: "limited",
allowed_hosts: [], allow_package_managers: false }` (`build.ts:169`) — la receta exacta
del doc. El gate de entrada valida el ejemplo ANTES de subir sus bytes a CMA
(`gatearEjemplo`, `build.ts:190`).

**Residuales de CMA — estado actualizado:**
- **Forma del webhook: CONFIRMADA (corrige una asunción de docs/13).** El webhook de
  CMA es THIN: sus `data.type` reales son `session.status_idled`,
  `session.status_terminated` y `session.outcome_evaluation_ended`, y NINGUNO dice si
  el build pasó — el éxito solo se sabe re-consultando la sesión
  (`outcome_evaluations[].result === "satisfied"`; `build.ts:32-36`, `:130-146`). Esto
  **corrige** los nombres inventados que docs/13 daba por buenos
  (`session.completed`/…). El desenlace se decide en `clasificarSesion`
  (`build.ts:130`), probada sin credenciales por `verify:cma`
  (`core/scripts/verify-cma-clasificar.ts`).
- **`allowed_hosts: []` no cae a un default permisivo — SIGUE a validar en vivo.** El
  código ya pone el toggle doble (`build.ts:168-169`); falta confirmarlo contra CMA
  real.
- **Run sin modelo — arquitectura fijada en código, validación en vivo pendiente.** El
  runner objetivo (contenedor gVisor) por construcción no invoca modelo y reporta $0 de
  tokens (`container-executor.ts:116`); `costoCmaEquivalente` (`executor.ts:181`) queda
  como cálculo de referencia. Que una sesión de sandbox CMA pura corra sin agente sigue
  sin probarse en vivo, pero ya NO está en la ruta crítica del Run (el Run es
  self-hosted).

---

## Decisión #1 — Aislamiento cross-tenant

**Confirmado parcial + mitigación concreta.** La doc de CMA confirma: **sandbox
fresco y aislado por sesión, sin filesystem compartido.** PERO **no dice qué
tecnología** (gVisor / microVM / contenedor) ni **confirma explícitamente** que
sea seguro entre fronteras de confianza mutuamente hostiles. Más aún, la doc de
sandboxes self-hosted aconseja *"un workspace/environment separado por cada
frontera de confianza"*.

**Recomendación:**
- **MVP (Build+Run en CMA):** el aislamiento lo heredas de CMA. **Mitigación que
  adoptamos: un environment separado por org** (no uno compartido entre tenants)
  — es la propia guía de Anthropic aplicada, y refuerza el aislamiento sin
  depender de saber la tecnología interna.
- **Fase 2 (runner propio):** **gVisor (`runsc`) desde el día 1 — no negociable.**

  **Actualización (2026-07-26):** este runner ya está CABLEADO en código —
  `ContainerRunExecutor` (`core/src/run/container-executor.ts`), con la jaula gVisor
  completa (`--runtime runsc --network none --read-only --user 65534 --cap-drop ALL
  --pids-limit`, `:87-102`). Falta desplegar la infra (host con Docker/nerdctl + runsc)
  y hacer el swap desde el puente Fase-0.

⚠️ **Residual:** como el activo #1 (datos cross-tenant) se apoya en el
aislamiento de CMA y la doc no confirma la tecnología ni la garantía anti-escape,
**preguntárselo directo a Anthropic** (soporte/cuenta) antes del primer cliente
con datos sensibles.

**Actualización (2026-07-26):** esto sigue aplicando **solo al build** (que sí vive en
CMA). Para el **Run** de código de IA — el activo real de docs/11 §1 — la mitigación
anti-escape ya no depende de CMA: es la jaula gVisor self-hosted (`ContainerRunExecutor`),
por lo que el aislamiento cross-tenant del Run pasa a estar bajo nuestro control.

---

## Decisión #2 — Egress del build → **RESUELTO, a favor**

Era el cuello de botella. **La doc confirma las dos piezas que lo cierran, y el
MVP NO necesita runner de build propio.**

- **`packages`** en la config del environment pre-instala las deps de la lista
  blanca (pip/npm/apt), **cacheadas por-environment** → el build **no necesita
  `pip` en runtime.**
- **`networking: { type: "limited", allowed_hosts: [...] }`** restringe el egress
  a hosts explícitos (hay `unrestricted` y `limited`; **no** hay un modo "none"
  literal, pero `limited` sin hosts es el equivalente funcional).

**La receta:** environment con `packages` pre-instalados + `networking: limited`
con **`allowed_hosts: []` y `allow_package_managers: false`**. Resultado: el build
corre con las deps ya puestas y **sin salida de red** — la superficie de
exfiltración-en-build se cierra, sin infra propia.

*(Matiz a probar: confirmar que `allowed_hosts: []` no cae por default a algo
permisivo; si no, poner el host más estrecho posible.)*

**Impacto en (c): el pipeline entero vive en CMA en el MVP.** Sin runner de build
propio. Este era el mayor riesgo de alcance y salió a favor.

---

## Decisión #3 — Cuota de ejecuciones → **el Run es MUCHO más barato de lo asumido**

La doc confirma el billing de CMA: **$0.08 por session-hour** (medido a
milisegundos, solo mientras corre) **+ tokens** (precio del modelo). El supuesto
de **$0.30/ejecución estaba inflado**.

Como **el Run no usa modelos** (decisión de arquitectura), su costo es **solo
session-runtime**: una corrida de 1–3 min ≈ **$0.002–0.004**, no $0.30.

**Consecuencias:**
- Los topes **50/100/200 estaban basados en un supuesto falso.** Con el Run a
  **<1¢**, los topes pueden ser **holgados** — los originales del doc
  (500/2,000/10,000) son viables con margen sano, o incluso "uso justo". El cap
  sigue siendo un backstop de abuso, pero generoso.
- **Retracto parcial del insight de roadmap:** el costo de CMA **no** aprieta las
  tarifas como creí. La urgencia económica de mover el Run a runner propio
  **baja** — sigue valiendo por *control* (Fase 2), no por costo.

⚠️ **Residual:** confirmar si ejecutar el script en CMA se puede hacer **sin
agente/modelo** (ejecución de sandbox pura = solo session-hours) o si obliga a una
sesión con agente (suma tokens). Eso fija el costo exacto del Run. Se prueba en
minutos cuando haya API.

**Impacto en (c) y docs/06:** cambiar "ejecuciones sin límite" por un tope
holgado; el metering que corta sigue siendo código de Fase 1, pero deja de ser
una restricción económica ajustada.

---

## Estado de (b): cerrado para (c)

Con los hechos confirmados, **(b) queda cerrado para efectos de secuenciar (c):**
- **#2 salió a favor** → el MVP **no** lleva runner de build propio; todo en CMA.
- **#3 el Run es <1¢** → topes holgados, no la restricción que creíamos.

Quedan **2 residuales que NO bloquean (c)** pero sí conviene cerrar antes del
primer cliente con datos sensibles:
1. La **garantía de aislamiento anti-escape** del sandbox cloud de CMA
   (la doc no dice la tecnología) — pregunta directa a Anthropic. Mitigación ya
   adoptada: environment por org.
2. Si el **Run puede correr sin modelo** (ejecución pura) — se prueba con la API.

   **Actualización (2026-07-26):** con el runner del Run ya decidido como contenedor
   gVisor self-hosted (a5-Fase 2), el Run corre python puro **sin modelo por
   construcción** ($0 de tokens, `core/src/run/container-executor.ts:116`); este
   residual — que era "¿CMA sabe correr sandbox sin agente?" — deja de estar en la ruta
   crítica del Run. Queda como validación en vivo, no como bloqueo.
