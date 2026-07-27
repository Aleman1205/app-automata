# 03 — El pipeline de Build

Detalle de [ARQUITECTURA.md](../ARQUITECTURA.md) §3 y §4.

El Build es un trabajo que dura minutos, cuesta dinero real y tiene que
sobrevivir a despliegues, reinicios y fallos de red. Es la pieza operativamente
más delicada del sistema.

---

## Estado de implementación (2026-07-26)

El loop asíncrono de build de este documento **ya está construido** en la Fase 1
(motor real en `core/`, framework-agnóstico; `web/` es solo el cableado a Next).
El flujo del papel — «espera un webhook, luego cosecha» — se realizó tal cual,
con una precisión importante: **el webhook de CMA es *thin*** (no trae el
resultado, solo avisa que la sesión cambió de estado); el desenlace del build
solo se sabe **re-consultando la sesión**. Todo lo de abajo tiene su script
`verify:*:pg` y está en verde (Postgres temporal en 55432; typecheck + build OK).

**El camino real, punta a punta:**

```
POST /construir           encola en build_pendiente (outbox); NO reserva aún
  → cron/disparo          drenarBuilds: planner → arrancarConstruccion
      → arrancarConstruccion  gate → reserva versión 'building' (cobra generación)
                              → arranca sesión CMA → graba cma_session_id (write-once)
  → CMA construye          (asíncrono; nadie espera con la conexión abierta)
  → webhook (thin)         status_idled → ENCOLA en cosecha_pendiente (outbox)
                           status_terminated → fallarAjuste in-tx (libera el 'en vuelo')
  → cron/cosecha           drenarCosecha: re-consulta la sesión (clasifica el
                           desenlace real) → descarga código → sube a storage
                           → guard de bytes → confirma → versión 'lista'
  reaper                   backstop: 'building' colgado > N min → 'failed' + incidente
```

| Pieza del doc | Estado | Evidencia (archivo:línea) | Verify |
|---|---|---|---|
| Encolar el build (§1, reserva) | **Hecho** | `core/src/http/endpoints.ts:131` (`solicitarBuildEP` → `app_solicitar_build`), outbox `core/db/schema.sql:332`, SD `core/db/schema.sql:569` | `verify:rutas` |
| Build-start: reservar antes de gastar (§1, §2 pasos 1–4) | **Hecho** | `core/src/pipeline/build-pipeline.ts:88` (`arrancarConstruccion`), cobro al arrancar `core/db/schema.sql:675`, drainer `core/src/pipeline/disparo.ts:31` | `verify:disparo:pg`, `verify:cuota:pg`, `verify:plan:pg` |
| Esperar sin bloquear worker (§2 paso 5) | **Hecho** (outbox + cron, no Inngest) | `core/src/cma/build.ts:283` (`arrancar` no espera), webhook `core/src/webhooks/handlers.ts:35` | `verify:webhooks:handlers:pg` |
| Cosechar el artefacto (§2 pasos 6–9) | **Hecho** | `core/src/pipeline/cosecha.ts:38` (`cosecharYConfirmar` / `drenarCosecha`), re-consulta `core/src/cma/build.ts:291` | `verify:cosecha:pg` |
| Éxito **solo por re-consulta**, no por el webhook | **Hecho** | `clasificarSesion` `core/src/cma/build.ts:130` | `verify:cma` |
| Webhooks: dedupe, orden, no-llegan (§3) | **Hecho** | dedupe/firma `core/src/webhooks/receptor.ts`, guard monótono Stripe `core/src/webhooks/handlers.ts:111`, reaper `core/src/ciclo/servicio.ts:286` | `verify:webhooks:handlers:pg`, `verify:incidentes:pg` |
| Reserva→confirma / build fallido libera (§1, §4) | **Hecho** | `fallarAjuste`/`confirmarAjuste` `core/src/pipeline/cosecha.ts:44,72`, compensación `core/src/pipeline/build-pipeline.ts:106` | `verify:ciclo:pg` |
| Circuit breaker de reparaciones (§4, §6) | **Hecho** (no estaba en el papel) | `cobrar_build` `core/db/schema.sql:638` | `verify:reparaciones:pg` |
| `task_budget` / `max_iterations` (§5) | **Parcial** | `MAX_ITERACIONES = 4` `core/src/cma/build.ts:39`, `TIMEOUT_MIN = 15` `core/src/cma/build.ts:40` | `verify:cma` |
| Tope de gasto acumulado en USD (§5) | **No** — el costo es best-effort de observabilidad, NO gatea | `reconstruirCosto` `core/src/cma/build.ts:307` | — |
| Métricas (§7) y decisiones abiertas (§8) | **Plan** | — | — |

**La corrección grande frente al plan original:** el webhook de CMA **no trae el
resultado**. Sus `data.type` reales son `session.status_idled`,
`session.status_terminated` y `session.outcome_evaluation_ended`
(`core/src/cma/build.ts:34`, allowlist en `core/src/webhooks/handlers.ts:20`) —
ninguno dice si el build *pasó*. El éxito solo se conoce re-consultando la sesión
y leyendo `outcome_evaluations[].result === "satisfied"`
(`clasificarSesion`, `core/src/cma/build.ts:130`). Por eso el handler del webhook
es deliberadamente tonto (solo encola) y la decisión de entrega vive en la
cosecha, fuera de la transacción del receptor. Esto **corrige** la suposición de
`docs/13` de nombres de evento tipo `session.completed` que traían el veredicto.

**Diferencias de forma con el papel (no son deudas, son cómo quedó):**

- **No hay Inngest.** Donde §2 dice `step.waitForEvent`, la implementación usa un
  **outbox + drainer por cron**: el webhook encola (`cosecha_pendiente` /
  `build_pendiente`), y un cron drena con `FOR UPDATE SKIP LOCKED`
  (`core/src/pipeline/cosecha.ts:96`, `core/src/pipeline/disparo.ts:37`). Mismo
  efecto (worker no bloqueado), sin dependencia de Inngest.
- **Los estados persistidos son `building` → `lista`/`ready` → `failed`.** No
  existe una fila en `queued` ni un estado `validating` en la BD: la cola entre
  «pedir» y «arrancar» es el outbox `build_pendiente`, y la puerta de calidad
  (Verifier) corre **dentro de CMA**, clasificada al cosechar
  (`clasificarSesion`). El schema acepta `lista` y `ready` a propósito
  (`core/db/schema.sql:812`).

---

## 1. Máquina de estados

La entrevista vive completa en la tabla `intakes` ([docs/10](10-intake.md) §9)
— la fila de `automations` **nace al aprobar**, directamente en `queued`:

> **Actualización (impl):** el estado persistido `queued` **no existe** en la BD.
> `POST /construir` encola en el outbox `build_pendiente`
> (`core/src/http/endpoints.ts:131`, tabla `core/db/schema.sql:332`) y la fila de
> automatización + versión nace directamente en `building` cuando el drainer
> arranca el build (`arrancarConstruccion`, `core/src/pipeline/build-pipeline.ts:88`;
> cobro de la generación en `cobrar_build`, `core/db/schema.sql:675`). La reserva
> de cuota, por tanto, ocurre **al arrancar** (en el drainer), no antes.
> `validating` tampoco es un estado propio en la BD: el Verifier corre dentro de
> CMA y su desenlace se clasifica al cosechar (`core/src/cma/build.ts:130`).

```
  queued ──► building ──┬──► validating ──► ready ──► (archived)
                        │         │
                        │         └──► failed ──► queued  (reintento, gratis)
                        └──► failed
```

| Estado | Quién lo activa | Cuota (espacio comprometido) | Visible como |
|---|---|---|---|
| `queued` | El cliente aprueba el spec | **Sí** (reserva) | «En cola» |
| `building` | El worker toma el trabajo | **Sí** | «Generando…» |
| `validating` | Llegó el artefacto, corre la puerta de calidad | **Sí** | «Generando…» |
| `ready` | Pasó la puerta de calidad | **Sí** | «Lista» |
| `failed` | Falló en cualquier punto | No — libera | «No se pudo — reintentar» |
| `archived` | El cliente la borra | No — libera | — |

Tres reglas que evitan la mayoría de los problemas:

**`validating` es un estado propio, no parte de `building`.** Necesitas
distinguir "el agente sigue trabajando" de "el agente terminó y estamos
comprobando". Cuando algo se atasque, esa diferencia te dice dónde mirar.

**La cuota es de espacios comprometidos, reservados al aprobar.** El check
ocurre en la transacción de aprobación del intake, con lock por organización,
y cuenta `queued + building + validating + ready` ([docs/10](10-intake.md)
§9). `failed` y `archived` liberan el espacio — un build fallido nunca deja
al cliente pagando por nada. Sin la reserva, N aprobaciones con builds en
vuelo pasan todas el check y revientan la cuota.

**Al cliente `building` y `validating` le suenan igual.** Los estados internos
son para ti; él ve tres cosas: Generando, Lista, No se pudo.

---

## 2. El trabajo de build, paso a paso

Cada paso es un **checkpoint**: si el trabajo revienta en el 5, al reanudar no
se repiten los pasos 1–4, que ya costaron tokens.

```
build(automation_id)
 ├─ 1. cargar spec         · marcar building
 ├─ 2. planner             · spec → tareas + rubric          [Opus, ~$0.10]
 ├─ 3. subir el archivo de ejemplo del cliente
 ├─ 4. crear sesión CMA + enviar user.define_outcome
 ├─ 5. ESPERAR el webhook  · el worker duerme, no consume nada
 ├─ 6. extraer artefacto de /mnt/session/outputs/
 ├─ 7. marcar validating   · puerta de calidad (docs/01 §6)
 ├─ 8. guardar en blob     · crear la versión
 └─ 9. ready + email
```

El paso 5 es el que define la infraestructura. **Nada de esperar con la conexión
abierta ni de hacer polling**: registras el webhook `session.status_idled` de
Anthropic y el trabajo se suspende hasta que llega. Con Inngest es
`step.waitForEvent`; el worker no está ocupado mientras tanto.

> **Actualización (impl):** el mecanismo quedó como **outbox + drainer por cron**,
> no Inngest. `arrancar()` abre la sesión y devuelve sin esperar
> (`core/src/cma/build.ts:283`); el webhook *thin* solo encola en `cosecha_pendiente`
> (`core/src/webhooks/handlers.ts:69`) y un cron drena con `FOR UPDATE SKIP LOCKED`
> (`core/src/pipeline/cosecha.ts:96`). Y ojo: el paso 6 **no** puede dispararse solo
> con que llegue el `status_idled` — ese evento no dice si el build pasó; hay que
> re-consultar la sesión (`clasificarSesion`, `core/src/cma/build.ts:130`), que
> además distingue un idle terminal de uno bloqueado en `requires_action`.

Un build que espera dos horas con un worker bloqueado es un worker perdido. Con
veinte builds simultáneos, es tu servicio caído.

---

## 3. Webhooks: los tres problemas

**Llegan duplicados.** Anthropic reintenta si no respondes 2xx. Guarda el
`event.id` en una tabla y descarta los repetidos. Sin esto, un build se procesa
dos veces y cobras dos veces.

**Llegan desordenados.** No asumas que `status_idled` llega después de todo lo
demás. Ordena por el `created_at` del sobre, no por el orden de llegada.

**A veces no llegan.** Es el caso que la gente olvida y el que deja
automatizaciones colgadas en «Generando…» para siempre. Necesitas un **barrido
de reconciliación**: un cron cada 10 minutos que busque builds en `building` con
más de N minutos y consulte el estado real de la sesión en la API.

```
cada 10 min:
  para cada build en `building` con más de 20 min:
    estado = sessions.retrieve(build.session_id).status
    si idle o terminated  → continuar el pipeline desde el paso 6
    si running            → dejarlo, pero si supera 60 min → failed

  para cada automation en `queued` sin job asociado con más de 10 min:
    re-despachar desde la fila outbox (docs/10 §9) — el commit pudo
    ocurrir sin que el encolado llegara a Inngest
```

Sin ese barrido, un webhook perdido es una automatización muerta y un cliente
que nunca recibe su correo. Es la clase de fallo que no ves en desarrollo y te
muerde en producción.

> **Actualización (impl):** el barrido existe como **`reaparBuildsColgados`**
> (`core/src/ciclo/servicio.ts:286`), pero es un **backstop que FALLA**, no uno
> que continúa desde el paso 6: marca `building` colgado > N min → `failed`, emite
> un incidente `build_colgado` por fila (generación pagada sin entregable) y limpia
> el outbox de cosecha. El camino que *continúa* el pipeline es el normal
> (webhook → `cosecha_pendiente` → `drenarCosecha`); el reaper es la red para
> cuando ese camino no ocurrió. Un `status_idled` que llega **después** de que el
> reaper ya marcó `failed` se detecta y levanta un incidente `pago_no_entregado`
> (`core/src/webhooks/handlers.ts:57`).

---

## 4. Taxonomía de fallos

No todos los fallos se tratan igual. Confundirlos es lo que hace que reintentes
lo que nunca va a funcionar y abandones lo que sí.

| Fallo | Reintentar | Consume cuota | Qué ve el cliente |
|---|---|---|---|
| Rate limit de la API | **Sí**, con espera creciente | No | Nada, es invisible |
| Error 5xx de Anthropic | **Sí**, hasta 3 veces | No | Nada |
| Sesión terminada por error | Sí, 1 vez | No | Solo si falla el reintento |
| Verifier agotó iteraciones | **No** automático | No | «No se pudo — reintentar» |
| Artefacto sin manifiesto | **No** | No | Igual |
| No pasa la puerta de calidad | **No** | No | Igual |
| Superó el presupuesto | **No** | No | Igual |

La línea que separa las dos mitades: **los fallos de infraestructura se
reintentan solos; los fallos de contenido no.** Si el Verifier agotó sus
iteraciones, repetir el mismo build da el mismo resultado y gasta el doble. Eso
necesita un spec distinto — o sea, al cliente.

**Cuando falla por contenido, ofrécele el botón de ajuste**, no un «reintentar»
a ciegas. «No conseguimos que funcionara. ¿Nos das más detalle sobre X?» — y ese
detalle entra al spec corregido.

---

## 5. Límites de gasto

Un agente en bucle de corrección es una factura que crece sola. Tres cinturones,
y los tres puestos:

```
1. task_budget          por sesión de CMA (mínimo 20k tokens)
2. max_iterations       tope del Verifier — recomiendo 4
3. presupuesto en USD   tu propio contador; a $10 se corta el build
```

El tercero no es redundante: es el único que ve el gasto **acumulado entre
reintentos**. Un build que falla tres veces a $4 cada uno son $12 aunque ninguno
haya pasado su límite individual.

> **Actualización (impl):** hoy están puestos el (2) `max_iterations` (= 4,
> `core/src/cma/build.ts:39`) y un timeout de sesión (15 min,
> `core/src/cma/build.ts:40`). El **corte por USD acumulado (3) NO está
> implementado como freno**: el costo se reconstruye *best-effort* re-listando los
> eventos de la sesión y es solo observabilidad — nunca gatea la entrega
> (`reconstruirCosto`, `core/src/cma/build.ts:307`; la fuente autoritativa del
> costo es la consola). El límite económico duro real hoy es la **cuota de
> generaciones por plan**, cobrada al arrancar (`cobrar_build`,
> `core/db/schema.sql:675`), más el circuit breaker de reparaciones
> (`core/db/schema.sql:638`).

Vigila también el **gasto por organización y día**. Un cliente que lanza treinta
builds en una tarde puede ser entusiasmo o puede ser un script. En ambos casos
quieres enterarte antes de la factura.

---

## 6. El flujo de ajuste

Cuando el cliente pide un cambio sobre una automatización que ya funciona:

```
1. Mini-entrevista: «¿qué está mal?» + opciones si aplica
2. Spec v2 = spec v1 + la corrección  (no se empieza de cero)
3. Build normal, con dos añadidos:
   · el artefacto v1 va como contexto — el agente parte de lo que ya servía
   · los ejemplos de v1 entran a la puerta de calidad como regresión
4. Si v2 pasa → mover current_version_id
   Si v2 falla → no pasa nada, v1 sigue viva
```

**El paso 3 es lo que evita el peor escenario del producto**: que un ajuste
menor rompa lo que ya funcionaba. Sin la regresión, el agente reescribe desde
cero, arregla lo que pediste y rompe otra cosa en silencio.

El ajuste **no consume cuota**. Es corrección, no una automatización nueva.

---

## 7. Qué medir

```
builds: id, automation_id, intento, estado, motivo_fallo,
        tokens_in, tokens_out, costo_usd, duracion_seg,
        iteraciones_verifier, session_id, creado_en
```

Cuatro números que miras cada semana. Son la salud del producto:

| Métrica | Objetivo | Si se sale de rango |
|---|---|---|
| Tasa de éxito | > 80% | El intake produce specs vagos, o el dominio es demasiado amplio |
| Costo medio | < $5 | Sube `effort`… o bájalo: a veces el modelo explora de más |
| Iteraciones del Verifier | 1–2 | Con 3+, el rubric es ambiguo y el grader no sabe decidir |
| Duración p95 | < 15 min | Revisar el tamaño de los archivos de ejemplo |

**«Iteraciones del Verifier» es el más informativo de los cuatro.** Si la media
sube, el problema casi nunca es el Builder — es que los criterios de éxito no
son verificables. Y eso se arregla en la entrevista, no en el prompt del agente.

Guarda siempre el `session_id`. Cuando un cliente se queje, es lo único que te
deja ver qué hizo el agente en realidad.

---

## 8. Decisiones abiertas

1. **¿Builds concurrentes por organización?** Sugerencia: 1 en el plan básico,
   3 en el superior. Protege tu gasto y es una palanca de venta natural.
2. **¿Reintento automático tras fallo de contenido?** Recomiendo que no: gasta
   el doble para llegar al mismo sitio. Mejor pedirle al cliente un dato más.
3. **¿Cuántos reintentos gratis?** Sugerencia: ilimitados mientras no lleguen a
   `ready`, con tope diario por organización para que no se abuse.
