# 08 — Ciclo de vida de una automatización

Modelo: **se construye una vez, se ajusta un número limitado de veces, y se
congela.**

---

## 1. El ciclo

```
  entrevista ──► v1 ──► el cliente prueba
                          │
                          ├── funciona ──────────────► CONGELADA
                          │
                          └── «necesito un cambio»
                                  │
                                  ▼
                          v2 (sobre v1)  ──► prueba
                                  │
                                  ├── funciona ─────► CONGELADA
                                  └── otro cambio
                                          │
                                          ▼
                                  v3 (sobre v2) ──► prueba
                                          │
                                          ├── funciona ─► CONGELADA
                                          └── un cambio más
                                                  │
                                                  ▼
                                          v4 (sobre v3) ─► CONGELADA
                                              (último ajuste)
```

**3 ajustes incluidos.** Cuatro versiones como máximo: la original y tres
revisiones. Después, la automatización queda fija y los agentes no la vuelven a
tocar.

Por qué 3 y no ilimitado:

- Es donde está la realidad: la mayoría queda bien en v1 o v2.
- Acota tu costo por automatización a ~$12 en el peor caso.
- **Le pone un final al proceso.** Sin límite, un cliente indeciso itera
  eternamente y nunca llega a usar lo que pidió. El límite es un favor.

---

## 2. Cambio ≠ reparación

Esta es la distinción más importante del documento, y si se ignora cuesta
clientes.

**Cambio** — el cliente quiere algo distinto de lo que pidió.

> «Además del total, quiero el promedio.»
> «Agrúpalo por región, no por vendedor.»

Consume uno de los 3 ajustes. Es trabajo nuevo.

**Reparación** — la automatización dejaba de hacer lo que ya hacía bien.

> Su sistema cambió el nombre de una columna.
> Una dependencia se rompió.
> Un caso raro en los datos que el ejemplo no traía.

**Es gratis, ilimitada, y no consume ajustes. Es tu obligación, no un favor.**

Piénsalo desde el cliente: pagó, la automatización funcionaba, dejó de
funcionar por algo que él no hizo, y le dices «ya gastaste tus tres ajustes».
Ese cliente se va y lo cuenta.

**Cómo distinguirlas sin discutir:** la suite de regresión ya está en el
artefacto. Corre el ejemplo original contra la versión actual.

| Resultado | Diagnóstico |
|---|---|
| El ejemplo original **falla** | **Reparación.** Algo se rompió. Gratis. |
| El ejemplo original **pasa** y el cliente quiere otra cosa | **Cambio.** Consume ajuste. |

Se decide con datos, no con criterio. Y se puede automatizar: al recibir una
queja, el sistema corre la regresión y clasifica solo.

---

## 3. Estados

Se añaden dos a la máquina de [docs/03](03-pipeline-build.md) §1:

| Estado | Significa | Ajustes |
|---|---|---|
| `ready` | Funciona, con ajustes disponibles | 1–3 restantes |
| `frozen` | Definitiva | 0 restantes |

Se llega a `frozen` de dos maneras:

1. **Se agotaron los 3 ajustes.**
2. **El cliente la da por buena.** Un botón: «Esta ya quedó». Ahorra tiempo a
   todos y da una sensación de cierre que el producto necesita.

Una automatización `frozen` sigue **ejecutándose con normalidad para siempre**.
Congelada significa que no se rediseña, no que se apaga.

---

## 4. El historial: qué ve el agente en un ajuste

El agente **no empieza de cero**. Recibe todo lo anterior:

```
Ajuste v3 — contexto que entra al build
  ├─ spec original (de la entrevista)
  ├─ historial de cambios:
  │    v2: «que también saque el promedio»  → qué se hizo
  ├─ artefacto v2 completo: código, manifiesto, requirements
  ├─ ejemplos de v1 y v2  ← regresión obligatoria
  └─ petición nueva del cliente
```

Instrucción explícita al agente:

> Partes de código que ya funciona. Haz el **cambio mínimo** que satisface la
> nueva petición. No reescribas, no reorganices, no "mejores" lo que no te
> pidieron. Todo lo que funcionaba debe seguir funcionando.

Sin esa instrucción, el agente reescribe desde cero, resuelve lo que pediste y
rompe otra cosa en silencio. **La puerta de calidad lo detecta** —los ejemplos
de v1 y v2 son regresión obligatoria— pero es mejor que no ocurra: cada rebuild
fallido gasta $3 y un ajuste del cliente.

---

## 5. Lo que ve el cliente

**Antes de gastar un ajuste, no después.** Si se entera del límite al pedir el
cuarto cambio, se siente engañado.

```
┌────────────────────────────────────────────┐
│  Reporte mensual de ventas       ● Lista   │
│                                            │
│  Ajustes disponibles:  ● ● ○   2 de 3      │
│                                            │
│  [ Ejecutar ]  [ Pedir un cambio ]         │
│  [ Esta ya quedó — congelarla ]            │
└────────────────────────────────────────────┘
```

Y en el momento de pedir el cambio, una confirmación honesta:

> Vas a usar tu **último ajuste**. Después de este, la automatización queda
> definitiva. Describe **todos** los cambios que necesites de una vez.

Ese aviso mejora la calidad de la petición: el cliente junta todo en vez de
gastar un ajuste por cada detalle que va recordando.

---

## 6. Cuando se acaban los ajustes y aún necesita cambios

Pasará. Tres salidas, y prefiero la tercera:

| Opción | A favor | En contra |
|---|---|---|
| Comprar un ajuste suelto ($10) | Ingreso directo | Se siente a nickel-and-dime |
| Consumir un espacio del plan | Sin dinero extra | Confunde: ¿por qué mi cambio ocupa un espacio? |
| **Crear una automatización nueva** | Honesto y claro | Ocupa un espacio del portafolio |

La tercera es la correcta porque **es verdad**: tras tres cambios de fondo, lo
que el cliente quiere ya no es la misma automatización. Que ocupe su propio
espacio refleja la realidad, y el cliente puede borrar la vieja si ya no le
sirve.

El mensaje:

> Esta automatización ya está definitiva. Si necesitas algo distinto, podemos
> crear una nueva a partir de ella — conservará todo lo que ya funciona y podrás
> pedir tres ajustes más. Ocupará un espacio de tu plan.

«Conservará todo lo que ya funciona» no es marketing: el artefacto y el spec
entran como contexto, así que la nueva parte del trabajo hecho.

---

## 7. Qué cambia en el pricing

Este modelo **sustituye** el contador de generaciones *visible* que propuse en
[docs/06](06-pricing.md) §4: el límite que el cliente ve vive en la
automatización, no en el mes.

Pero el contador no desaparece del todo — se vuelve **interno**: sin él, el
"reciclador" de docs/06 §3 regresa por la puerta de atrás (archivar libera
espacio → crear otra → 1 build + 3 ajustes nuevos, en bucle). Queda como tope
invisible de **builds iniciados por mes = 2× los espacios del plan** (Base 6,
Pro 12, Equipo 20), aplicado al aprobar la entrevista
([docs/10](10-intake.md) §8). Nadie normal lo toca; quien lo toque ve "has
creado muchas automatizaciones este mes — escríbenos si necesitas más".

> Los montos de esta sección están en USD como ilustración de la *lógica* del
> margen. Los precios de venta reales van en pesos ($499 / $999 / $1,999 MXN,
> [docs/06](06-pricing.md) §8) — el razonamiento de abajo no cambia, solo la
> moneda, y en pesos el margen es algo más apretado por la tensión costos-USD.

```
Plan Base — $30/mes (ilustrativo; real: $499 MXN)
  3 automatizaciones activas
  Cada una: 1 construcción + hasta 3 ajustes
  Reparaciones: gratis e ilimitadas
  Ejecuciones: sin límite
```

Un solo mensaje, sin contadores mensuales. Mucho más fácil de explicar.

**El costo, en el peor caso del plan Base:**

```
3 automatizaciones × 4 builds × $3  =  $36    contra $30 de ingreso
```

Mes 1 en pérdida de $6 **solo si los tres clientes agotan los tres ajustes**, lo
cual es improbable. Y a partir del mes 2 el margen es de ~$30 limpios, porque no
hay más builds. Es coste de adquisición, y se recupera en el segundo mes.

Si prefieres no perder ni en el peor mes: **2 ajustes en el plan Base, 3 en los
superiores.** Sale a $27 sobre $30. Yo empezaría con 3 en todos —la generosidad
inicial compra reseñas y recomendaciones, que valen más que $6— y lo ajustaría
si los datos muestran que la gente los agota de verdad.

---

## 8. Lo que hay que medir

| Métrica | Qué te dice |
|---|---|
| Distribución de versión final (v1/v2/v3/v4) | **La calidad de tu entrevista.** Si domina v1, el intake funciona. Si domina v4, el spec sale mal. |
| % que se congela voluntariamente | Satisfacción real |
| % que agota los 3 ajustes | Si supera el 30%, faltan ajustes o sobra ambigüedad en el intake |
| Tasa de reparaciones | Fragilidad de tus artefactos |
| Motivo del ajuste 1 | **Oro puro**: son las preguntas que el intake debió hacer y no hizo |

La última es la más valiosa del producto. Cada primer ajuste es un fallo de la
entrevista, y esa lista es tu hoja de ruta para mejorar el intake. Cuando un
motivo se repite en varios clientes, se convierte en una pregunta nueva del
agente entrevistador.

---

## 9. Decisiones abiertas

1. **¿3 ajustes en todos los planes?** Recomiendo sí al principio, por
   simplicidad. Diferenciarlos por tier es una palanca que puedes usar después.
2. **¿Caducan los ajustes?** Recomiendo que no. Un cliente que descubre a los
   seis meses que necesita un cambio y ya no puede pedirlo se siente estafado
   por una letra pequeña.
3. **¿La reparación automática es transparente?** Si el sistema detecta el fallo,
   repara y avisa después, es magia. Si pregunta antes, es fricción. Recomiendo
   reparar y avisar — pero **nunca** cambiar el comportamiento sin decirlo.
