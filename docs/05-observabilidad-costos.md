# 05 — Observabilidad, costos y calidad

Detalle de [ARQUITECTURA.md](../ARQUITECTURA.md) §6.

---

## 1. Lo que mata a este negocio

Un SaaS normal tiene coste marginal casi cero: un cliente que usa mucho la app
te cuesta prácticamente lo mismo que uno que no la abre. **El tuyo no.**

Cada automatización cuesta dólares de tokens. Cada ejecución cuesta cómputo. Un
cliente de $49 al mes que crea diez automatizaciones y ejecuta a diario **te
puede costar $80** — y no te enteras, porque el producto funciona
perfectamente. No hay caída, no hay error, no hay queja. Solo margen negativo.

**El riesgo aquí no es que se caiga el servicio. Es que gane clientes y pierdas
dinero con cada uno.** Toda la observabilidad de este documento existe para que
eso sea visible desde el primer mes.

---

## 2. Atribución de costos

**Regla no negociable: toda llamada a un modelo se etiqueta en el punto donde
se hace.** Si no etiquetas ahí, no hay forma de reconstruirlo después — y la
factura de Anthropic llega agregada, sin decirte qué cliente la generó.

```ts
await registrarUso({
  org_id, automation_id, build_id,
  fase: "intake" | "planner" | "builder" | "verifier",
  modelo, tokens_in, tokens_out,
  cache_read, cache_write,
  costo_usd,
});
```

La fase importa. Cuando el costo medio suba, esa columna te dirá si fue el
Verifier iterando de más, el Builder explorando, o la entrevista alargándose.
Sin ella solo sabes que "subió".

Con esa tabla, tres preguntas se contestan solas:

- ¿Cuánto me cuesta cada organización este mes?
- ¿Cuál es el margen real de cada plan?
- ¿Qué fase del pipeline se está comiendo el presupuesto?

---

## 3. El número que importa: margen por organización

```
margen_org = precio_plan
           − Σ costo_builds     (tokens)
           − Σ costo_runs       (cómputo)
           − almacenamiento
```

Un panel interno, ordenado por margen ascendente. Los de arriba son los que te
están costando dinero.

**Míralo cada semana desde el primer cliente.** Con cinco clientes es un rato;
con cincuenta, si nunca lo miraste, es una crisis.

Lo que te va a enseñar ese panel, casi seguro: **la distribución no es
uniforme.** Un puñado de clientes genera la mayoría del costo. Con ese dato
decides — límite de cuota, tier superior, o hablar con ellos — pero solo si lo
estás mirando.

---

## 4. Alarmas

Pocas y accionables. Una alarma que salta y nadie atiende entrena al equipo a
ignorarlas todas.

| Alarma | Umbral | Acción |
|---|---|---|
| Build individual caro | > $10 | Cortar el build, marcar `failed` |
| Gasto diario de una org | > 3× su media | Revisar: ¿entusiasmo o script? |
| Gasto diario global | > presupuesto | Avisarte a ti |
| Tasa de fallos de build | > 20% en 1 h | Algo se rompió |
| Builds atascados | en `building` > 60 min | Reconciliar (ver [docs/03](03-pipeline-build.md) §3) |
| Tasa de fallos de ejecución | > 10% en 1 h | Artefactos frágiles o Runner roto |
| Cola de builds | > 20 esperando | Falta capacidad |

Las dos primeras son las que te salvan dinero de verdad. Las demás son higiene.

---

## 5. Calidad: el problema raro de este producto

Con software normal, el código es determinista: si pasan los tests, funciona
igual mañana. **Con agentes, no.**

Cambias una línea del prompt del Builder. Mejora en tres casos y empeora en
cinco. Los tests pasan porque no tienes tests de esto. Te enteras por las quejas,
tres semanas después, y ya no recuerdas qué cambiaste.

Lo mismo pasa **sin tocar nada**: un modelo nuevo, un cambio en la API, y tu
tasa de éxito se mueve sola.

### La suite de regresión

Es tu única red. Es lo más valioso que vas a construir después del producto
mismo.

```
evals/
  casos/
    001-ventas-mensual/     spec.json, entrada.csv, salida-esperada.xlsx
    002-facturas/           ...
    ...
    020-...
  correr.js
```

Empieza con 10 casos reales, llega a 20–30. **Cada fallo en producción se
convierte en un caso nuevo** — así la suite crece justo por donde el producto
se rompe.

**Córrela antes de tocar nada de esto:**

- El prompt del sistema de cualquier agente
- El modelo o el `effort`
- La plantilla del rubric
- La imagen base del Runner

Lo que mides en cada corrida:

| Métrica | Qué te dice |
|---|---|
| Tasa de éxito | ¿Sigue funcionando? |
| Costo medio | ¿El cambio salió caro? |
| Iteraciones del Verifier | ¿El rubric sigue siendo claro? |
| Casos que cambiaron de resultado | **El más importante** |

La última fila es la clave: no te interesa solo el total, te interesa **qué caso
concreto pasó de aprobar a fallar**. Un cambio que sube la media pero rompe el
caso que tu mejor cliente usa a diario es un mal cambio.

### Variabilidad

Corre cada caso **3 veces**, no una. Los agentes no son deterministas: un caso
que pasa 2 de 3 no está "bien", está frágil. Esa fragilidad predice quejas
futuras mucho mejor que un aprobado suelto.

---

## 6. Rastrear una queja

Un cliente dice "esto está mal". Tienes que poder llegar al fondo en minutos:

```
run_id
  → version_id → artefacto (código exacto que corrió)
                → build_id → session_id de CMA (qué hizo el agente)
                           → spec → entrevista (qué pidió el cliente)
  → entrada y salida de esa ejecución concreta
```

Con esa cadena distingues las tres causas posibles, que se arreglan en sitios
distintos:

| Causa | Se arregla en |
|---|---|
| El cliente pidió otra cosa | La entrevista (mejores preguntas) |
| El spec estaba bien pero el código no lo cumple | El Builder / el rubric |
| El código está bien pero el archivo era distinto | El manifiesto (alias, validación) |

**Guarda `session_id` siempre.** Sin él, cada queja es una investigación desde
cero y no aprendes nada sistemático.

---

## 7. Herramientas

No construyas nada de esto tú:

| Para | Usa |
|---|---|
| Errores y trazas | Sentry |
| Métricas de negocio y costos | Una tabla en Postgres + Metabase |
| Logs | Los de tu plataforma (Vercel, Fly) |
| Estado de los jobs | El panel de Inngest |
| Trazas de agentes | La consola de Anthropic |

El panel de costos por organización **sí** lo construyes tú — es específico de
tu producto y es el que decide tu pricing. Una consulta SQL y una tabla bastan.
No hace falta nada bonito.

---

## 8. Decisiones abiertas

1. **¿Le enseñas el costo al cliente?** Recomiendo que no en el MVP: le hace
   pensar en tokens en vez de en su proceso. Sí muéstrale la cuota usada.
2. **¿Cortas o cobras de más al superar la cuota?** Recomiendo cortar y ofrecer
   subir de plan. Una factura sorpresa cuesta el cliente entero.
3. **¿Con cuántos casos arranca la suite de regresión?** Sugerencia: no lances
   la Fase 1 con menos de 10. Antes de eso vuelas a ciegas.
