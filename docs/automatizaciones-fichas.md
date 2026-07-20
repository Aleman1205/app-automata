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
