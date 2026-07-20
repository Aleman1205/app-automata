# Resultado del spike (corrida real)

> El número que contesta el riesgo #1 del proyecto. Corridas reales contra
> Managed Agents (Anthropic), no simulación. Última: 2026-07-20 (n=3).

## Veredicto: 3/3 ✓

| Caso | Tipo de tarea | Resultado | Iter. | Costo (run.js) |
|---|---|---|---|---|
| `dashboard-popularidad` | Dashboard de Excel sucio (2 tablas apiladas) | ✅ | 1 | $1.36 |
| `ventas-mensual` | Tabla pivote (vendedor × mes) | ✅ | 1 | $1.23 |
| `facturas-consolidado` | Agrupar por RFC + IVA + dedup | ✅ | **2** | $1.14 |

**3/3 aprobados · 9.5 min promedio.** Todos a ciegas: el agente solo recibió el
spec y el archivo, descubrió la solución solo, y un grader independiente la
confirmó.

## Lo que prueba

1. **La tesis completa, a ciegas.** No es que la tarea *tenga* solución (eso lo
   vio `FACTIBILIDAD.md`); es que el **agente la encuentra sin pistas** y el
   Verifier la valida. Build → verify → entregable, de punta a punta.
2. **La auto-corrección funciona.** `facturas-consolidado` falló la verificación
   #1 (`needs_revision`), el agente se corrigió y pasó en la #2. El loop
   Verifier↔agente —el corazón de la arquitectura— operó en vivo.
3. **Amplitud.** Tres dominios distintos (reporte, pivote, consolidación
   administrativa) con el mismo pipeline. Sin una pantalla por dominio.

## El costo: cuidado, run.js SUBCUENTA

run.js reporta **$1.24/build promedio**, pero solo suma tokens de modelo del
stream — **no cuenta el compute del sandbox** de Managed Agents.

**Calibración:** la 1ª corrida de Vitrales la consola la cobró en **$2.80**;
run.js calculó **$1.36** para el mismo build. Factor ≈ **2×**.

→ **Costo real por build ≈ $2.5-2.8.** El número exacto se lee en la consola
(saldo de créditos antes vs. después), no en run.js.

Contra los umbrales:
- Asunción de la arquitectura: ~$3/build. Real ~$2.5-2.8. ✅ **por debajo.**
- "El negocio cierra": < $5. ✅ **holgado, incluso con el 2× de subcuenta.**
- "Para": > $10. Ni cerca.

## Economía (con costo real ~$2.7/build)

Build = costo **de una sola vez** por automatización; el Run no usa modelos.

- Plan $499 MXN ≈ **$27 USD**. Si incluye ~3 automatizaciones: 3 × $2.7 =
  **~$8** de build, una vez. Margen sano ya en el mes 1; los siguientes, casi
  puro margen.
- **A vigilar: los ajustes.** Cada automatización permite 3 reparaciones
  ([docs/08](../docs/08-ciclo-de-vida.md)) y cada una vuelve a costar ~$2.7.
  El caso facturas ya mostró que un ajuste puede pasar solo — bien —, pero la
  métrica *"% que agota los 3 ajustes"* sigue siendo la que hay que monitorear.

## Lo que NO prueba

- **Datos sintéticos.** Los tres archivos son inventados (con la forma sucia
  real). Un archivo real más raro podría costar o fallar distinto.
- **n=3 es señal decente, no ley.** Da un rango ($1.1-1.4 en run.js, ~$2.5-2.8
  real) y 3/3 de éxito — suficiente para arrancar Fase 1, no para garantizar
  que ningún proceso salga caro.
- No mide intake real, planner real, ni el Run — ver [FACTIBILIDAD.md](FACTIBILIDAD.md).

## Historial de corridas

- **2026-07-20, n=1:** Vitrales, ✓ 6/6, **$2.80** (consola). La corrida imprimió
  `✗ $0.00` por un bug de descarga (archivo no-descargable) — ya arreglado.
- **2026-07-20, n=3:** los 3 casos, ✅ 3/3, run.js $1.24 prom (~$2.7 real).
