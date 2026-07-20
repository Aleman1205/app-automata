# Prueba de factibilidad (sin API)

> **Qué es esto.** Una prueba manual de la mitad de **factibilidad** del spike,
> hecha **sin la API de Anthropic** (bloqueada por el pago). No reemplaza al
> spike real — lo complementa. Fecha: 2026-07-20.

## La pregunta que contesta

El spike tiene dos preguntas metidas en una:

1. **Factibilidad** — ¿la tarea *se puede* construir? ¿Un parser puede navegar el
   Excel sucio de Vitrales y producir el dashboard correcto sin caer en la trampa?
2. **Costo** — ¿cuánto cuesta un build con Managed Agents? (el número del que
   cuelga el pricing)

Esta prueba contesta **solo la #1**. La #2 sigue necesitando la API.

## Método

Se hizo de **Builder** y **Verifier** a mano, sobre el `gastos.xlsx` sintético
(mismos números que valida el rubric de [`casos.js`](casos.js), caso
`dashboard-popularidad`):

- **Builder** → [`factibilidad/automatizacion.py`](factibilidad/automatizacion.py):
  un script **reutilizable** que recibe la ruta del Excel, detecta la tabla de
  detalle por su encabezado (no por número de fila), corta al llegar a la segunda
  tabla ("Totales por familia"), descarta la fila "Total" con columnas corridas, y
  produce `resultado.json` + `dashboard.xlsx` + `manifiesto.json`.
- **Verifier** → [`factibilidad/verificar.py`](factibilidad/verificar.py):
  evalúa el `resultado.json` contra los 6 criterios, **calculando los totales de
  forma independiente**.

## Resultado: ✓ 6/6 criterios

| # | Criterio | Resultado |
|---|---|---|
| 1 | Estructura (métricas + familias + top) | ✓ |
| 2 | 448 productos (no ~492) | ✓ **448** |
| 3 | Ingreso $53,239,430.50 (no ~$106M) | ✓ **exacto** |
| 4 | Utilidad $26,100,916.43, margen 49.0% | ✓ **exacto** |
| 5 | 44 familias + consistencia (suma familias == total) | ✓ |
| 6 | Top: TACO DE FILETE · JUGO DE TOMATE (~425,783 / ~410,761) | ✓ |

**Prueba de reutilización:** con 3 filas de basura extra insertadas arriba del
archivo, el script encontró la tabla solo y dio los mismos números — no está
hardcodeado a este archivo.

## Reproducir

Desde la raíz del repo:

```bash
npm install
npm run datos:vitrales                    # genera spike/datos/gastos.xlsx
OUT=spike/salidas/dashboard-popularidad; mkdir -p "$OUT"
python3 spike/factibilidad/automatizacion.py spike/datos/gastos.xlsx "$OUT"
python3 spike/factibilidad/verificar.py "$OUT"
```

Requiere Python 3.9+ con `openpyxl`. Las salidas caen en `spike/salidas/`
(gitignoreado).

## Qué prueba y qué NO

**Prueba:**
- La tarea **es resoluble**: la lógica para limpiar el Excel sucio existe y da el
  resultado correcto.
- El **rubric es alcanzable y correcto** — no pide algo imposible ni mal calculado.
- El producto es **técnicamente posible** para este tipo de proceso.

**NO prueba (sigue pendiente):**
1. **El costo por build ($/build).** Necesita la métrica de Managed Agents. Es la
   otra mitad del spike, bloqueada por el pago de la API.
2. **No fue a ciegas.** El resultado correcto ya se conocía. Esto demuestra que la
   tarea tiene solución limpia, **no** que un agente sin pistas la descubra solo
   (eso es justo lo que mide el spike real: darle solo el spec y ver si llega).
3. Nada del **intake, planner real, el Run, ni los demás agentes** — ver el mapeo
   en la conversación / [`casos.js`](casos.js).

## Conclusión

El riesgo técnico "¿esto siquiera se puede construir?" queda **despejado**: sí se
puede, y el rubric es correcto. Lo único que falta para cerrar el spike es el
**número de costo**, y para eso sí se necesita la API (ver el pendiente de pago
de créditos en `../CLAUDE.md`).
