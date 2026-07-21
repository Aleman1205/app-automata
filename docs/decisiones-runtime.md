# Decisiones de runtime (resuelve docs/11 §12)

> Las 3 decisiones que el red-team elevó a "necesitan decisión de negocio"
> ([docs/11](11-threat-model.md) §12), con **recomendación decidida**. Los hechos
> de CMA se **confirmaron contra la doc oficial** (2026-07-21). Quedan 2
> residuales que necesitan pregunta directa a Anthropic (no bloquean el plan).

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

⚠️ **Residual:** como el activo #1 (datos cross-tenant) se apoya en el
aislamiento de CMA y la doc no confirma la tecnología ni la garantía anti-escape,
**preguntárselo directo a Anthropic** (soporte/cuenta) antes del primer cliente
con datos sensibles.

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
