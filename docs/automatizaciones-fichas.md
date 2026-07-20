# Fichas de automatizaciones (catálogo 🟢 fit-puro)

> Diseño en profundidad de 3 automatizaciones que **caben en el motor actual**
> (input → proceso → resultado, sin estado, sin integraciones, **Run sin
> modelos**). Cada ficha: intake · insumo · bloques de resultado · dónde se rompe
> el fit. Complementa `docs/mercado-microsaas.md` (qué se puede) con el *cómo*.

## Tres principios que aplican a todas

1. **El código no adivina columnas.** Como el Run es determinista, el mapeo de
   columnas siempre importa. **Pero no se le pide en frío al usuario:** el Builder
   inspecciona el archivo de muestra (el spike probó que lo hace) y **propone** el
   mapeo — *"veo que 'Vend.' es el vendedor, ¿sí?"*. El usuario confirma, no
   captura. Misma info, cero jerga.
2. **La ambigüedad se resuelve en TRES lados, no solo en el intake:**
   (a) **intake** — decisiones de negocio (tolerancias, modelo de comisión);
   (b) **inspección del Builder en el build** — estructura/formato (lo absorbe
   solo, como cuando descubrió las 2 tablas de Vitrales sin que nadie le dijera);
   (c) **bucket "a revisar" en el Run** — lo que ni así se pudo decidir.
   Esto descarga el intake: no todo es pregunta, y así no se vuelve un formulario
   de 12 campos.
3. **El patrón de salida es siempre el mismo** (y es nuestro sistema de bloques):
   `resumen` arriba + tablas por estatus + **siempre una tabla "a revisar"**. Ese
   bucket de excepciones es lo que hace vendible el "sin modelo": el código hace
   el 90% determinista y te devuelve el 10% dudoso, en vez de fingir que lo
   resolvió. Se arma con los bloques que ya existen (`resumen`, `tabla`,
   `callout`, `comparacion`) — sin componentes nuevos.

---

## 1. Conciliación de pagos vs. estado de cuenta

**Intake**
- ¿Qué es cada archivo? (A = mis pagos/cobros registrados · B = movimientos del banco)
- Mapeo de columnas de cada uno (fecha, monto, referencia/folio, concepto) — *propuesto por el agente*
- ¿Hay una referencia compartida entre ambos? (folio, # de operación) — sí/no
- Tolerancia de fecha (ej. ±3 días — el banco liquida con desfase)
- Tolerancia de monto (ej. $0, o ±X para absorber comisiones bancarias)
- Signo: ¿el banco maneja cargos/abonos en columnas separadas o un monto con signo? *(inferible en el build)*

**Insumo:** 2 archivos Excel/CSV (registro interno + estado de cuenta exportado).

**Bloques de resultado**
- `resumen`: total registrado, total banco, diferencia neta, % conciliado.
- `metricas` / tablas por estatus: conciliados exacto · conciliados con tolerancia
  ("revisar rápido") · en banco no en registro · en registro no en banco ·
  diferencias de monto (misma referencia, monto distinto → comisión o error).
- `callout` "a revisar": las partidas ambiguas.

**Dónde se rompe el fit:** sin referencia compartida, casar solo por monto+fecha
vuelve ambiguos dos pagos iguales el mismo día — el código no puede "decidir"
cuál es cuál. Sigue siendo fit puro, pero la calidad depende de que exista la
referencia. El intake lo pregunta de frente; si no hay, baja la promesa a
"sugiere posibles matches, tú confirmas".

---

## 2. Facturas → consolidado

> **Ajuste clave (México): no es PDF, es XML.** Toda factura mexicana es un
> **CFDI = un XML del SAT** con estructura fija (RFC emisor/receptor, UUID,
> subtotal, IVA, total como campos). El contador ya trabaja con esos XML.
> **Parsear el XML es determinista y a prueba de balas — sin OCR, sin varianza de
> maqueta.** Apuntando al XML, esta automatización pasa de "alto valor pero
> frágil" a **una de las más seguras.** El PDF queda como fallback (caso 🟡, con
> las salvedades de layout).

**Intake**
- Tipo de factura: **CFDI (XML)** / PDF de un proveedor / mixto
- Campos a extraer (default: UUID, fecha, emisor+RFC, receptor+RFC, subtotal, IVA, total, moneda)
- ¿Agrupar por? (emisor, RFC, mes)
- ¿Marcar duplicados por UUID? sí/no

**Insumo:** los XML del periodo (o el ZIP que da el contador). PDF con texto solo como fallback.

**Bloques de resultado**
- `tabla` consolidada: una fila por factura con los campos pedidos.
- `metricas`: suma de subtotal, IVA y total; conteo de facturas.
- `barras`/`tabla` agrupado por emisor/RFC o mes.
- `callout` "a revisar": facturas con algún campo ilegible (no se descartan).
- Posibles duplicados: mismo UUID repetido.

**Dónde se rompe el fit:** con XML no se rompe (estructura estándar). Solo si el
cliente insiste en PDFs de maqueta arbitraria vuelve la fragilidad de layout →
ahí el intake advierte y sube la tasa de "a revisar".

---

## 3. Cálculo de comisiones

**Intake**
- Modelo de comisión: **% plano** (global o por vendedor) / **% por producto o categoría** / **escalonado por volumen** (tiers)
- Base del cálculo: monto vendido / margen / unidades
- Parámetros del modelo:
  - Plano: el % · Por producto: tabla producto→% · Escalonado: los cortes (ej. 0–100k=3%, 100k–300k=5%, +300k=7%) y si el tier aplica a todo el monto o solo al excedente
- Periodo a calcular
- ¿Descontar devoluciones/notas de crédito? sí/no
- Mapeo de columnas (vendedor, monto/unidades, producto, fecha) — *propuesto por el agente*

**Insumo:** ventas en Excel/CSV. Reglas: por campos si son pocas; si son muchas,
un 2º archivo (tabla de reglas). Vale soportar ambos.

**Bloques de resultado**
- `resumen` + `metricas`: total a pagar en comisiones, # vendedores, promedio.
- `ranking`/`tabla` por vendedor: ventas del periodo, regla/tier aplicado, comisión.
- Desglose por línea (opcional): cada venta con su % y comisión — para auditar.
- `callout` "a revisar": ventas sin vendedor, o productos sin regla que los cubra.

**Dónde se rompe el fit:** la expresividad de las reglas. El código fija bien lo
parametrizable (plano, por producto, escalonado). Cuando hay excepciones a mano
("a este cliente no, en Q4 sube, si vino de campaña cambia"), eso ya no cabe en
campos sin volverse un mini-lenguaje. Regla honesta: cubre los 3 modelos
estándar y sus combinaciones; las excepciones caso-por-caso caen en "a revisar".

---

## Prioridad

- **Comisiones:** la más fácil de cerrar (intake acotado, solo depende del CSV).
- **Facturas (XML):** el mayor techo de valor y, con el XML, también segura.
- **Conciliación:** muy relatable; su calidad vive de la referencia compartida.

---

## Primitivos fiscales MX (tratarlos como tipos del sistema)

Se repiten en las 3 y el Builder debe manejarlos siempre:

- **RFC** — validar 12 caracteres (persona moral) vs. 13 (persona física).
- **Subtotal / IVA / Total** — **nunca asumir si el monto trae o no IVA.** El
  total de un export suele venir con IVA; el análisis de ventas se hace sobre
  **subtotal**. IVA general **16%**, **8%** en frontera norte/sur.
- **UUID (folio fiscal CFDI)** — llave para deduplicar facturas.
- **Formato peso con centavos** (`$1,234,567.89`) — el descuadre de centavos por
  IVA/comisión es la fuente #1 de falsos "no cuadra".
- **ClaveProdServ (SAT)** — si el insumo es CFDI, ya viene; sirve para agrupar.

### Métricas MUST-HAVE por reporte (no nice-to-have)

- **Ventas:** ventas totales (subtotal) · **% cumplimiento vs. objetivo** ·
  variación vs. periodo anterior · ticket promedio. *(Una cifra de ventas sola,
  sin objetivo, no dice nada.)*
- **Conciliación:** saldo libros vs. banco + diferencia neta · # y monto no
  conciliado (por lado) · % conciliado · monto de diferencias por captura/comisión.
- **Comisiones:** total bruto **y neto post-retenciones** · comisión por vendedor
  · # en "a revisar" · **total de retenciones (ISR+IVA) a enterar al SAT**.

### Retenciones a comisionistas (el detalle que casi todos omiten)

El intake **debe preguntar empleado vs. comisionista externo** — cambia todo:

- **Comisionista externo** (factura honorarios): del neto se restan retenciones.
  - **ISR**: 10% (persona física, Art. 106 LISR); **1.25%** si está en RESICO
    y cobra de persona moral (Art. 113-J).
  - **IVA retenido**: siempre **2/3 del IVA** = 16% × 2/3 = **10.6667%**
    (5.3333% en frontera).
  - **Neto = comisión + IVA − IVA retenido − ISR retenido.** (Coincide con el
    total del CFDI que emite el comisionista.)
- **Empleado**: la comisión va **por nómina** (ISR por tarifa, sin IVA). Sin
  retención de honorarios.

### Reason codes canónicos (bucket "a revisar")

- **Ventas:** sin vendedor · producto sin ClaveProdServ · RFC faltante/ inválido
  · Total ≠ Subtotal+IVA · fecha fuera de periodo · duplicado (UUID) · moneda ≠ MXN.
- **Conciliación** (partidas conciliatorias clásicas): depósito en tránsito ·
  cheque pendiente de cobro · cargo/abono del banco no correspondido · comisión
  bancaria · intereses · cheque sin fondos · error del banco · error de captura
  (mismo folio, monto distinto) · duplicado. **Regla de oro:** las no
  correspondidas se arrastran ("roll forward") hasta resolverse; las conciliadas
  se etiquetan con folio de auditoría.
- **Comisiones:** venta sin vendedor · producto sin regla · monto fuera de todos
  los tiers · vendedor sin RFC/régimen · devolución posterior al corte (clawback)
  · venta no cobrada (si paga sobre cobrado) · comisión con adeudo del vendedor
  · excepción manual.
