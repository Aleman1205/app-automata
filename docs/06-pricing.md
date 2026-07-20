# 06 — Precios y cuotas

Análisis de la propuesta: **$30 → 3 automatizaciones · $50 → 6 · $100 → 10**.

---

## 1. Los costos con los que se hace la cuenta

De [docs/02-runtime](02-runtime.md) y [docs/03](03-pipeline-build.md):

| Concepto | Costo | Frecuencia |
|---|---|---|
| Build de una automatización | ~$3 (rango $1–5) | **Una vez** |
| Ajuste / rebuild | ~$3 | Cada vez que lo pida |
| Ejecución — runner propio | ~$0.001 | Cada uso |
| Ejecución — sesión de CMA | ~$0.30 | Cada uso |
| Almacenamiento | ~$0.01/mes | Por automatización |

---

## 2. La cuenta, tier por tier

Supuesto: cada automatización se ejecuta **una vez al día**.

### $30 / 3 automatizaciones · 90 ejecuciones al mes

| | Con runner propio | Con CMA |
|---|---|---|
| Mes 1 (3 builds + runs) | $9.09 → **margen $21** | $36 → **pérdida $6** |
| Mes 2+ (solo runs) | $0.09 → **margen $29.9** | $27 → **margen $3** |

### $100 / 10 automatizaciones · 300 ejecuciones al mes

| | Con runner propio | Con CMA |
|---|---|---|
| Mes 1 | $30.30 → **margen $70** | $120 → **pérdida $20** |
| Mes 2+ | $0.30 → **margen $99.7** | $90 → **margen $10** |

### Las dos conclusiones

**Tu precio funciona — pero solo con el runner propio.** Con CMA como runtime de
ejecución, los tres tiers pierden dinero o dejan un margen ridículo. El atajo que
recomendé para el MVP en [docs/02](02-runtime.md) **caduca en cuanto tengas
clientes reales que ejecuten a diario**, no cuando "haya volumen". Ese es el
plazo real de la migración.

**El costo está en los builds, no en las ejecuciones.** Con contenedores
propios, un cliente que ejecuta cada hora en vez de cada día te cuesta $14 al mes
en vez de $0.09 — sigue siendo irrelevante. **Lo caro es generar, no correr.**
Por eso tu modelo de cobrar por automatizaciones en el portafolio va en la
dirección correcta.

---

## 3. El agujero: la cuota es un stock, y los builds son un flujo

«3 automatizaciones en tu portafolio» cuenta **cuántas tienes**, no **cuántas
has generado**. Y generar es lo que cuesta.

Tres formas en que eso te desangra, todas realistas:

**El reciclador.** Crea 3, borra una, crea otra, borra, crea… Si borrar libera
espacio, un cliente de $30 puede generar cuarenta automatizaciones en un mes:
**$120 de costo sobre $30 de ingreso.** No hace falta mala fe — alguien
experimentando llega ahí solo.

**El ajustador infinito.** Los ajustes no consumen cuota (así lo definimos en
[docs/03](03-pipeline-build.md) §6). Veinte ajustes al mes son $60 de costo en un
plan de $30. Y el cliente cree que está haciendo lo correcto: refinando.

**El que falla mucho.** Los reintentos son gratis, pero cada intento fallido
consumió tokens igual.

**Ninguno de los tres es un abuso. Son usos razonables de las reglas que
escribimos.** Por eso hay que cambiar las reglas, no confiar en la buena fe.

---

## 4. La solución: dos contadores, un solo mensaje

Necesitas limitar el **stock** (cuántas tiene) y el **flujo** (cuántas genera).
Pero el cliente no debe tener que entender dos conceptos.

**Propuesta:**

```
Plan Base — $30/mes
  3 automatizaciones activas
  6 generaciones al mes

Plan Pro — $50/mes
  6 automatizaciones activas
  12 generaciones al mes

Plan Equipo — $100/mes
  10 automatizaciones activas
  20 generaciones al mes
```

Una **generación** es cualquier build que termina en `ready`: una automatización
nueva o el ajuste de una existente. Los builds fallidos no cuentan.

El límite de generaciones = **el doble de los espacios**. Eso deja margen de
sobra para crear todo y ajustarlo un par de veces, y corta en seco a los tres
casos de arriba. Peor escenario del plan Base: 6 × $3 = **$18 sobre $30**. El
margen no baja del 40% ni en el mes más caro.

> **Decisión final** ([docs/08](08-ciclo-de-vida.md) §7): el contador visible
> se sustituyó por el modelo de 3 ajustes por automatización, y esta cifra
> (2× espacios/mes) sobrevive como **tope interno anti-abuso** aplicado al
> aprobar la entrevista ([docs/10](10-intake.md) §8). La aritmética de este
> documento sigue siendo el techo de costo real.

Y un regalo que te sale barato y le encanta al cliente:

> **Los ajustes durante los primeros 30 días no cuentan.**

Es cuando ocurre la mayoría de los ajustes —el cliente está afinando lo que
acaba de recibir— y comunica exactamente lo correcto: *hasta que quede bien, no
te cobramos por corregirlo*. El costo extra es pequeño porque está acotado en
tiempo.

---

## 5. Qué le mantiene pagando

La pregunta incómoda del modelo por stock: si al mes 4 ya tiene sus 3
automatizaciones funcionando, **¿por qué sigue pagando $30?**

Cuatro respuestas legítimas, en orden de peso:

1. **Ejecutarlas.** Solo corren en tu plataforma. Es el motivo real.
2. **Mantenimiento.** Cuando su archivo cambie, la reparas. Eso vale mucho.
3. **Ajustes.** Su proceso cambia; la automatización se adapta sin programar.
4. **Guardado.** El artefacto, el historial, los resultados.

De ahí sale que **el valor recurrente es la ejecución, no la creación** — y eso
confirma el modelo. Pero tiene una consecuencia: hay un dinamismo de rehén (deja
de pagar y pierde su trabajo) que algunos clientes resienten.

Cómo suavizarlo sin regalar el negocio:

- **30 días de solo lectura tras cancelar** para descargar todos los resultados.
- **Exportar el código** en el plan superior. Suena a regalar el producto, pero
  el código sin tu plataforma no se ejecuta solo, no se mantiene y no se ajusta.
  Lo que vendes es el servicio; el código es el subproducto. Quien lo pide es
  precisamente el cliente empresarial que necesita esa garantía para firmar.

---

## 6. Un tramo que falta

Entre "no soy cliente" y "$30 al mes" hay un salto de fe grande para alguien que
no sabe si esto le va a funcionar. **La primera automatización es la que vende
el producto** — ninguna descripción convence tanto como ver su propio proceso
resuelto.

Dos formas, y prefiero la segunda:

| Opción | A favor | En contra |
|---|---|---|
| **Prueba gratis: 1 automatización** | Cero fricción, máxima conversión | Te cuesta $3 por curioso; invita al abuso con correos desechables |
| **Pago único: $15 por la primera** | Filtra curiosos, recuperas el costo, quien paga $15 paga $30 | Menos registros, más fricción |

Con $3 de costo por build, una prueba gratis abierta es un grifo abierto. **$15
por la primera automatización** filtra, te deja en positivo desde el registro, y
convierte mucho mejor de lo que parece: quien ya pagó $15 y vio funcionar su
proceso, sube a $30 sin pensarlo.

---

## 7. Si el precio es el correcto, no lo sé — y tú tampoco todavía

Los márgenes salen. Lo que ninguna hoja de cálculo te dice es si **$30 es lo que
esta gente pagaría**.

La referencia útil: un proceso que le lleva 4 horas al mes a alguien que cuesta
$15/hora son **$60 de valor mensual**. A $30 estás en la mitad, que es una
posición vendible. Pero eso es teoría.

**Antes de fijar precios, enséñale el producto funcionando a cinco personas con
ese problema y pregúntales qué pagarían.** Es media semana de trabajo y vale más
que cualquier análisis. Si los cinco dicen "$100 sin dudarlo", dejaste dinero en
la mesa con $30. Si dicen "$10", el problema no es el precio, es el segmento.

---

## 8. Recomendación

| | Base | Pro | Equipo |
|---|---|---|---|
| Precio | $30 | $50 | $100 |
| Automatizaciones activas | 3 | 6 | 10 |
| Generaciones al mes | 6 | 12 | 20 |
| Ejecuciones | 500/mes* | 2,000/mes* | 10,000/mes* |
| Ajustes primeros 30 días | Gratis | Gratis | Gratis |
| Usuarios | 1 | 3 | 10 |
| Exportar código | — | — | Sí |

\* **Con corte duro, no solo alarma** — corrección de seguridad
([docs/11](11-threat-model.md) §8). Mientras el Run viva en CMA (~$0.30/
ejecución), "ejecuciones ilimitadas" es una puerta abierta: una cuenta de $15
podría ejecutar miles de veces y costarte cientos de dólares. El tope se
comunica como generoso ("hasta 500 al mes en Base") y al tocarlo ofrece subir
de plan. Cuando el Run migre al runner propio (Fase 2, ~$0.001/ejecución), el
tope puede subir mucho o volverse "uso justo" real — pero el corte se queda,
porque quitarlo del código es más difícil que relajar el número. Los límites
exactos se afinan con datos de uso reales.

**Primera automatización: $15, pago único.**

Tres cosas que hacer antes de publicar estos números:

1. Correr el spike y confirmar que el build cuesta ~$3 y no ~$15. **Todo este
   documento se apoya en ese número.**
2. Preguntarle a cinco clientes potenciales qué pagarían.
3. Decidir el límite de generaciones — es la pieza que evita el desangrado.

---

## 9. Decisiones abiertas

1. **¿Anual con descuento?** Dos meses gratis al pagar el año mejora el flujo de
   caja justo cuando más lo necesitas. Recomiendo sí, desde el principio.
2. **¿Cobras por usuario extra?** Con `viewer` gratis e ilimitado el producto se
   difunde solo dentro de la empresa. Recomiendo `viewer` gratis.
3. **¿Qué pasa al bajar de plan** con más automatizaciones activas que espacios?
   Sugerencia: se conservan pero en solo lectura; elige cuáles reactivar.
