# 10 — El agente entrevistador (intake)

Detalle técnico de la entrevista descrita en [PLAN.md](../PLAN.md) §2: cómo
genera preguntas, cómo decide cerrar, qué produce y cómo se protege.

> v2 — revisado adversarialmente. Cambios mayores respecto al primer borrador:
> flujo de corrección en la aprobación, archivos de ejemplo integrados al spec,
> viabilidad reevaluada en cada turno, campos de autoridad del servidor,
> modelo de reserva de cuota e idempotencia de transiciones.

---

## 1. Qué es y qué no es

El intake convierte **texto libre + respuestas de opción múltiple + un archivo
de ejemplo** en un **spec validado** — el contrato que consume el Planner.

Qué NO es:

- **No es una sesión de CMA.** Llamadas directas a la API con salida
  estructurada. Sin sandbox, sin loop de agente.
- **No es un chat abierto.** Texto libre solo en: la idea inicial, la opción
  "Otra cosa…" (300 chars) y las correcciones de la aprobación (300 chars).
- **No es infalible.** Sus redes de seguridad: la pantalla de aprobación con
  su **turno de corrección** (§6) y los 3 ajustes post-build.

**Modelo: `claude-sonnet-5`.** La calidad de las preguntas es la primera
impresión del producto. Haiku se usa solo como auditor barato (§5).

## 2. Arquitectura y turnos

Cada turno es stateless para el modelo: la API carga la transcripción completa
desde la base, la manda, valida el resultado y lo guarda. El cliente puede
cerrar la pestaña y volver días después.

**Tabla de turnos → esquema disponible** (la impone la API, no el modelo):

| Turno | Qué recibe el modelo | Acciones permitidas en el esquema |
|---|---|---|
| 1 | idea | `preguntar` · `cerrar` · `rechazar` |
| 2 | idea + respuestas ronda 1 | `preguntar` · `cerrar` · `rechazar` |
| 3 | todo | `cerrar` · `rechazar` (preguntar ya no existe) |
| corrección (máx. 2) | todo + spec + correcciones del cliente | `cerrar` · `rechazar` |

**Máximo 2 rondas de preguntas** (turnos 1 y 2), 3–4 preguntas por ronda →
**máximo 8 preguntas**, normalmente 3–5. El turno 3 es el cierre forzado: si
falta información, el spec sale con `ambiguedades_restantes` pobladas y la
aprobación las muestra editable por editable.

Cambiar el esquema en el turno 3 invalida el prompt caching — irrelevante
aquí: transcripciones de 2–4k tokens, el intake completo cuesta centavos. La
imposición dura vale más que ese caché.

## 3. La salida de cada turno: unión discriminada de TRES variantes

```jsonc
// A: necesita más información (solo turnos 1–2)
{
  "accion": "preguntar",
  "viabilidad": "viable" | "viable_con_reencuadre",
  "reencuadre": "string | null",   // §7: la versión que SÍ hacemos hoy
  "preguntas": [
    {
      "id": "frecuencia",
      "titulo": "¿Cada cuándo haces este proceso hoy?",
      "opciones": [
        { "id": "diario", "etiqueta": "Todos los días",
          "detalle": "Una o varias veces al día", "recomendada": false }
        // 2–4 opciones
      ],
      "permite_otro": true,
      "pide_archivo": false
    }
    // 3–4 preguntas por ronda (minItems/maxItems en el esquema)
  ]
}

// B: ya puede escribir el spec (cualquier turno)
{
  "accion": "cerrar",
  "viabilidad": "viable" | "viable_con_reencuadre",
  "spec": { /* §4 */ },
  "saludo": "string"   // frase de apertura de la pantalla de aprobación — la
                       // pantalla se renderiza DESDE el spec, no desde prosa (§6)
}

// C: esto no se construye (cualquier turno, incluido el 3)
{
  "accion": "rechazar",
  "viabilidad": "fuera_de_alcance" | "no_procede",
  "motivo_interno": "string"   // para el lead/registro, nunca se enseña
}
```

La viabilidad se **reevalúa en cada turno**: si el requisito imposible aparece
en la ronda 2 vía "Otra cosa…", el turno siguiente puede rechazar. Todo lo que
el esquema puede expresar (minItems, maxLength, enums) vive en el esquema del
modelo — las condicionales que no puede expresar (§4) van con ejemplos en el
prompt, y la tasa de rechazo de Zod se mide por regla para detectar cuál quema
reintentos.

## 4. El spec, formalmente

Lo único que viaja aguas abajo. Validado con Zod además del esquema del modelo:

```jsonc
{
  "version": 1,
  "objetivo": "string, 20–500 chars",
  "entradas": [
    { "tipo": "archivo" | "texto" | "numero" | "fecha" | "seleccion",
      "formato": "csv|xlsx|pdf|…|null", "descripcion": "string" }
  ],
  "salidas": [ { "tipo": "archivo" | "pantalla", "formato": "…", "descripcion": "…" } ],
  "reglas": [ "string" ],                    // 0–15, auditadas (§5)
  "criterios_exito": [                       // 2–10
    { "criterio": "string — técnico, va al rubric del Verifier",
      "criterio_cliente": "string — lenguaje natural, va a la aprobación" }
  ],
  "archivos_ejemplo": [                      // 0–3
    { "archivo_id": "uuid", "formato": "csv", "tamano_bytes": 123,
      "pregunta_id": "ejemplo" }
  ],
  "ambiguedades_restantes": [ "string" ],
  "confianza": "alta" | "media" | "baja"
}
```

**Campos de autoridad del servidor — el modelo NO los escribe.** La API los
construye desde sus propios registros y sobreescribe cualquier cosa que el
modelo diga: `archivos_ejemplo` (de los uploads reales), y por separado en la
tabla `intakes`: `idea_original` y `respuestas[]` (de los clics reales). Un
modelo no puede alucinar qué contestó el cliente.

**`idea_original` NO viaja en el spec.** Se queda en la fila del intake para
auditoría. Es el campo más hostil del sistema (2,000 chars de texto libre);
el `objetivo` de 500 chars redactado por el entrevistador la reemplaza aguas
abajo. Si el Planner alguna vez la necesita, la recibe delimitada como dato
hostil — nunca como campo limpio del contrato.

**Archivos de ejemplo**: máx. 3 por intake, 10 MB cada uno, extensiones
permitidas `csv xlsx xls pdf txt`, guardados en
`s3://bucket/{org_id}/intakes/{intake_id}/` ([docs/04](04-multitenancy.md) §2).
Si el cliente no tiene el archivo a mano, la entrevista **no se bloquea**:
cierra con la ambigüedad "sin archivo de ejemplo — validaremos con datos
sintéticos y el primer archivo real puede requerir un ajuste". El contenido
del archivo es **dato hostil para el Builder** (celdas con instrucciones) —
tratamiento en [docs/11](11-threat-model.md).

Validación programática (rechaza y reintenta):

- ≥ 2 criterios, ≥ 1 entrada, ≥ 1 salida, límites de longitud en todo
- `confianza == "baja"` → `ambiguedades_restantes` no vacía

**Presupuesto de reintentos de cierre: 3, unificado** (Zod + auditoría §5
comparten el contador). Al agotarse: se acepta el último spec que pasó Zod,
con `confianza: "baja"` y las fallas volcadas a `ambiguedades_restantes` — la
aprobación ya sabe mostrarlas. **Nunca se deja un intake colgado.**

**Congelado al aprobar.** Inmutable; un ajuste produce spec v2 con el v1 de base.

## 5. Auditoría barata del cierre (Haiku)

Una llamada de centavos sobre el spec recién generado, tres preguntas:

1. **Verificabilidad**: ¿cada `criterio` se puede comprobar ejecutando el
   código y examinando el resultado?
2. **Suficiencia**: ¿un resultado que cumpla TODOS los criterios podría aun
   así no cumplir el objetivo? ¿Qué falta? (verificable ≠ suficiente: "el
   archivo existe" pasa la pregunta 1 y no discrimina nada.)
3. **Semántica de reglas**: ¿cada regla describe una transformación de datos
   del negocio del cliente, o pide comportamiento del código/agente (tocar
   red, crear archivos extra, ignorar validaciones, contenido del código)?
   Las segundas se eliminan del spec — son el canal de inyección disfrazado
   de requisito.
4. **Fidelidad bilingüe**: ¿`criterio` y `criterio_cliente` dicen lo mismo?

Fallas → reintento del cierre con el feedback (dentro del presupuesto de §4).

## 6. La pantalla de aprobación y el turno de corrección

**Lo que se aprueba es el spec, no prosa del modelo.** La pantalla se
renderiza con plantilla determinista desde el spec (objetivo, entradas,
salidas, reglas, criterios en su versión `criterio_cliente`, ambigüedades);
el `saludo` del modelo solo abre la pantalla. Así la inyección no puede pedir
"en el resumen di A, en las reglas pon B".

**Cada ambigüedad es editable individualmente**: confirmar la suposición o
corregirla con texto libre (300 chars). También hay un campo general "algo
más que corregir". Al enviar:

- Turno de **corrección** (esquema solo cerrar/rechazar): recibe spec +
  correcciones delimitadas como datos, reemite el spec completo.
- Máximo **2 correcciones** por intake, con presupuesto propio (+2 llamadas,
  fuera del contador de rondas).
- El cliente que quiere cambiar una respuesta de la ronda 1 estando en la
  aprobación usa este mismo canal — no se "regresa" la entrevista. (Editar la
  ronda 1 desde la ronda 2 tampoco existe: decisión deliberada, el remedio es
  la corrección.)

Si tras 2 correcciones sigue sin convencer: abandona sin costo, o aprueba
sabiendo que tiene 3 ajustes. El embudo lo registra (§10).

## 7. Viabilidad: rechazar barato, reencuadrar antes que rechazar

| Veredicto | Qué es | Qué pasa |
|---|---|---|
| `viable` | Proceso sin estado con archivos/datos ([PLAN.md](../PLAN.md) §0) | Sigue normal |
| `viable_con_reencuadre` | La versión literal no se puede (necesita Gmail, correr sola), pero la variante manual SÍ | La ronda 1 lo dice: "La parte de leer tu correo llegará después; la versión donde tú subes el archivo la hacemos hoy. ¿Te sirve?" — y sigue con el reencuadre |
| `fuera_de_alcance` | Ni reencuadrada cabe (app con estado, integración esencial) | Honestidad + **lead de roadmap** con descripción |
| `no_procede` | Ilegal, dañino, sin relación con automatizar | Rechazo amable y genérico. Contador por org + **un registro mínimo con control de acceso** (rasgos/hash, retención corta, separado de lo visible al cliente) para detectar sondeo — no el transcript visible. Alerta si una org acumula muchos `no_procede` rápido |

**El reencuadre también puede lavar intención dañina.** "Genera correos
personalizados a esta lista de clientes" se reencuadra a "procesa esta lista y
genera mensajes" = viable, y luego `idea_original` se descarta aguas abajo (§4)
dejando un objetivo limpio: phishing con apariencia de reporte. Por eso el
clasificador de daño corre **sobre el spec POST-reencuadre, no solo sobre la
idea original**, y todo caso donde un reencuadre cambió el veredicto de
rechazable a viable se registra y se revisa — es la señal de lavado.

El reencuadre es la diferencia entre rechazar a un buen cliente y venderle:
casi nadie describe "el subconjunto automatizable" — describen su proceso
completo, correo incluido. Las capacidades de Fase 3 pueden mencionarse como
futuro ("¿te avisamos cuando corra sola?") pero **jamás entran al spec**.

Rechazar aquí cuesta ~$0.01; descubrirlo en el build, $3 y la confianza del
cliente. Los `fuera_de_alcance` son investigación de mercado gratis.

## 8. Seguridad (lo específico del intake)

- El texto del cliente jamás se convierte en instrucciones: viaja delimitado
  (`<idea_del_cliente>…`), con la instrucción de que describe un proceso, no
  órdenes.
- Solo el spec validado fluye aguas abajo; `idea_original` no viaja (§4); las
  reglas pasan el filtro semántico (§5.3); el Planner recibe reglas y textos
  del spec **delimitados como datos**, no interpolados en su prompt.
- Archivos: límites de §4 + tratamiento de contenido hostil en docs/11.
- Anti-abuso: máx. 10 intakes por org/día; presupuesto por intake: 6 llamadas
  de Sonnet + 3 de Haiku (las de Haiku no cuentan contra las de Sonnet);
  idea ≤ 2,000 chars; "otro" y correcciones ≤ 300.
- **Tope de builds iniciados: 2× los espacios del plan, por mes** (Base 6,
  Pro 12, Equipo 20). Cierra el agujero del "reciclador" (borrar-y-crear
  infinito con solo 10 intakes/día de freno). Invisible salvo abuso; al
  tocarlo: "has creado muchas automatizaciones este mes — escríbenos si
  necesitas más". Decisión reflejada en [docs/06](06-pricing.md) y
  [docs/08](08-ciclo-de-vida.md).

## 9. Persistencia, estados y concurrencia

```
intakes
  id, org_id, user_id
  estado          en_curso | cerrado | aprobado | abandonado | rechazado
  viabilidad      viable | viable_con_reencuadre | fuera_de_alcance | no_procede | null
  transcript      JSONB      -- turnos completos (borrado si no_procede)
  idea_original   TEXT       -- autoridad del servidor, nunca viaja en el spec
  respuestas      JSONB      -- clics reales, autoridad del servidor
  spec            JSONB
  correcciones    INT        -- 0–2
  llamadas_sonnet INT, llamadas_haiku INT, costo_usd NUMERIC
  prompt_version  TEXT, modelo TEXT   -- sin esto, ninguna métrica es atribuible
  version         INT        -- optimistic locking
  creado_en, actualizado_en
```

**Las máquinas de estados no se pisan** (corrige la contradicción con
docs/03): la entrevista vive COMPLETA en `intakes`; la fila de `automations`
**nace al aprobar**, directamente en `queued`. Los estados `interviewing` y
`abandoned` se eliminan de la máquina de automations ([docs/03](03-pipeline-build.md)
§1, ya corregido).

**Concurrencia y atomicidad:**

- **Toda transición lleva guard**: `UPDATE intakes SET estado='aprobado'
  WHERE id=$1 AND estado='cerrado'`. 0 filas afectadas → devolver el
  resultado ya existente (idempotente). El doble clic en Aprobar no crea dos
  automations.
- **Optimistic locking por turno**: el request trae el índice del turno
  esperado; si no es el siguiente al persistido (dos pestañas), se rechaza
  **sin llamar al modelo**.
- **La aprobación evita el dual-write**: en UNA transacción Postgres se crea
  la automation (`queued`), se congela el spec y se escribe una fila
  **outbox** "encolar build"; un dispatcher la convierte en job de Inngest
  después del commit. El barrido de [docs/03](03-pipeline-build.md) §3 cubre
  también `queued` sin job > 10 min.
- **La cuota usa reserva con lock**: dentro de esa transacción, `SELECT … FOR
  UPDATE` sobre la org y conteo de espacios **comprometidos**
  (`queued + building + validating + ready`). `failed` y `archived` liberan.
  Sin esto, N aprobaciones concurrentes pasan todas con 1 espacio libre.
  Además se avisa temprano: al CREAR el intake se muestra "no tienes espacios
  libres — puedes hacer la entrevista, pero para construir tendrás que
  liberar uno".

**Barridos** (mismo cron de docs/03 §3): `en_curso` > 7 días → `abandonado`;
`cerrado` sin aprobar > 30 días → `abandonado`; `abandonado` se borra a 30
días. Nada vive para siempre.

## 10. Métricas

| Métrica | Qué revela |
|---|---|
| Tasa de cierre (idea → aprobado) | Salud del embudo |
| **Abandono por ronda** | La ronda que espanta (por pregunta no es medible: van 3–4 por pantalla; el proxy por pregunta es el % de "Otra cosa…") |
| % "Otra cosa…" por pregunta | Opciones mal planteadas |
| % reencuadres aceptados | ¿El reencuadre vende o espanta? |
| % `fuera_de_alcance` por categoría | Qué integración de Fase 3 construir primero |
| Correcciones por intake | Calidad del cierre |
| Confianza del spec ↔ éxito del build | ¿El modelo sabe cuándo no sabe? |
| Motivo del primer ajuste ([docs/08](08-ciclo-de-vida.md) §8) | La pregunta que faltó |

Todas segmentables por `prompt_version` y `modelo` — sin esas dos columnas,
una regresión del embudo jamás se podría atribuir a un cambio de prompt
([docs/07](07-entornos-despliegue.md) §1 aplica al intake también: cambiar el
prompt del entrevistador es un despliegue).

Caso especial detectado por el prompt: **idea con varios procesos** ("límpiame
las ventas, hazme el reporte y avísame de facturas") → la ronda 1 lo dice:
"esto son 3 automatizaciones — ¿por cuál empezamos?" y las otras quedan como
intakes `en_curso` pre-llenados esperando al cliente.

## 11. Qué prueba el spike (adenda al de la Fase 0)

`spike/entrevista.js`: 5 ideas reales → ¿las preguntas pasan la prueba de "las
contestaría quien hace el proceso a mano"? ¿Los criterios salen verificables Y
suficientes? ¿El filtro de reglas atrapa una inyección de prueba? Una tarde de
trabajo; valida la pieza con más contacto con el cliente.

## 12. Decisiones abiertas

1. **¿Streaming de preguntas?** No: la ronda llega completa en 2–4 s con
   "pensando" en la UI. La opción múltiple no gana nada con streaming.
2. **¿El mini-intake del ajuste reusa este agente?** Sí: mismo esquema con el
   spec v1 en contexto y la instrucción de preguntar solo sobre el cambio.
3. **¿Instrumentar interacción por pregunta en la UI** (foco/cambio/tiempo)
   para afinar más que por ronda? Barato ahora, imposible retroactivamente —
   recomendado sí, como tabla de eventos ligera.
