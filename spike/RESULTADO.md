# Resultado del spike (corrida real)

> El número que contesta el riesgo #1 del proyecto. Corrida real contra Managed
> Agents (Anthropic), no simulación. Fecha: 2026-07-20.

## Veredicto

| | |
|---|---|
| Caso | `dashboard-popularidad` (Excel sucio de Vitrales) |
| Resultado | ✅ **APROBADO — 6/6 criterios** |
| Iteraciones del Verifier | **1** (aprobado a la primera, sin reintentos) |
| Tiempo | ~11 min |
| **Costo del build** | **USD 2.80** |
| Sesión | `sesn_01UeZzRHFM7TgqwoJ7gTf13K` |

El costo se confirmó en la consola (Gasto del mes = $2.80; créditos $20 → $17.21
restantes = $2.79 gastado). El grader independiente encontró los 6 criterios
cumplidos: script reutilizable + `resultado.json` con métricas, familias y top.

## Cómo leerlo

- **Asunción de la arquitectura:** ~$3/build. **Real: $2.80.** ✅ por debajo.
- **Umbral "el negocio cierra":** < $5. ✅ holgado.
- **Umbral "para":** > $10. Ni cerca.

La mitad de **costo** del spike —el riesgo #1— salió a favor. Sumado a que el
pipeline real (Builder + Verifier de Managed Agents) funcionó de punta a punta
sobre datos sucios, la tesis técnica del producto queda validada.

## Economía (aproximada)

Build = costo **de una sola vez** por automatización; el Run no usa modelos.

- Plan $499 MXN ≈ **$27 USD** (tipo de cambio ~18.5, aprox).
- Si incluye ~3 automatizaciones: 3 × $2.80 = **$8.40 USD** de build, una vez.
- Margen bruto sano ya en el mes 1; los meses siguientes son casi puro margen.

**El detalle a vigilar:** los **ajustes**. Cada automatización permite hasta 3
reparaciones ([docs/08](../docs/08-ciclo-de-vida.md)), y cada una vuelve a costar
~$2.80. En el peor caso (3 automatizaciones × 3 ajustes) el costo del mes 1 sube
a ~$33 y se come el margen. Por eso la métrica *"% que agota los 3 ajustes"* de
docs/08 es la que hay que monitorear: si supera ~30%, el intake produce specs
malos y la economía se aprieta.

## Lo que este número NO prueba

- **Es n=1.** Un build a $2.80 no prueba que *todos* lo sean. Un proceso más
  grande o ambiguo puede costar más. **Para sostener el pricing hay que correr
  varios casos** (activar sintéticos en [casos.js](casos.js)).
- No mide intake, planner real, ni el Run — ver [FACTIBILIDAD.md](FACTIBILIDAD.md).

## Nota de la corrida

La corrida imprimió falsamente `✗ 0/1 · $0.00` por un bug del harness: tras
aprobar el Verifier, la descarga de outputs reventó con un archivo no-descargable
(400) y el `catch` borró el veredicto y el costo. **Ya está arreglado** (descarga
best-effort en [run.js](run.js)); el resultado real fue el ✓ 6/6 de arriba.
