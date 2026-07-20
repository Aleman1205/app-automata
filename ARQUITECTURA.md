# Arquitectura — detalle técnico

Complementa [PLAN.md](PLAN.md). Aquí van las decisiones que el plan menciona
pero no resuelve.

---

## 1. El artefacto: el contrato entre Build y Run

Esta es la decisión central. **El Builder no entrega "código" — entrega un
artefacto ejecutable, versionado y autocontenido.** Si el artefacto está mal
definido, el Run es impredecible y no hay forma de reproducir una ejecución.

```
artefacto/
  automatizacion.py      punto de entrada, recibe --input y --output
  requirements.txt       dependencias con versión EXACTA (pandas==2.2.3)
  manifiesto.json        qué entradas pide  → genera el formulario del cliente
  ejemplo/
    entrada.csv          el archivo con el que se validó
    salida.xlsx          el resultado aprobado por el Verifier
  meta.json              spec, rubric, modelo usado, costo, fecha
```

Cuatro reglas que hacen que esto funcione:

**Versiones fijas, siempre.** `pandas==2.2.3`, nunca `pandas`. Sin esto, una
automatización que funcionó en enero falla en marzo porque una dependencia
cambió. El cliente no perdona eso y no tiene forma de entenderlo.

**El ejemplo viaja con el artefacto.** No es documentación, es la prueba de
regresión. Antes de cada despliegue —y ante cualquier duda— corres el artefacto
contra `ejemplo/entrada.csv` y comparas con `ejemplo/salida.xlsx`. Si no
coincide, algo se rompió.

**El script no sabe nada de tu plataforma.** Lee un archivo, escribe otro,
imprime logs a stdout. Sin llamadas a tu base de datos, sin credenciales, sin
red. Así el sandbox de ejecución puede ser mínimo y desechable.

**El manifiesto es el contrato con la UI.** El frontend genera el formulario de
ejecución leyendo este JSON. El cliente nunca ve código porque nunca hace falta.

```jsonc
{
  "entradas": [
    { "nombre": "archivo_ventas", "tipo": "archivo", "formato": "csv",
      "descripcion": "El export mensual de ventas", "requerido": true }
  ],
  "salidas": [{ "nombre": "reporte", "tipo": "archivo", "formato": "xlsx" }],
  "runtime": "python-3.12"
}
```

---

## 2. El runtime de ejecución (Run)

Aquí está tu margen. Un build cuesta $1–5 y ocurre una vez; una ejecución debe
costar centavos y ocurrir miles de veces.

| Opción | Arranque | Costo/ejecución | Veredicto |
|---|---|---|---|
| **A. Sesión de CMA por ejecución** | ~10-20s | $0.10–1 (paga tokens) | Simple, cero infra nueva. **Caro y lento.** |
| **B. Contenedor propio efímero** (Fly Machines, Cloud Run Jobs) | 1-3s | ~$0.001 | Barato, control total. Hay que construirlo. |
| **C. Sandbox como servicio** (E2B, Modal) | <1s | ~$0.01 | Rápido, poca infra. Dependencia externa. |
| **D. Ejecutar en tu servidor** | 0s | $0 | **Nunca.** Código generado por IA en tu proceso = fin de la empresa. |

**Recomendación: A en el MVP, B en la Fase 2.**

Usar CMA también para el Run te deja lanzar el MVP sin construir infraestructura
de ejecución. Es caro, pero con pocos clientes da igual — y te compra semanas.
El día que las ejecuciones sean volumen, migras a B: la interfaz `Runner` ya
está aislada, cambias una implementación.

**La señal para migrar:** cuando el costo mensual de ejecuciones pase el 20% de
tu ingreso, o cuando alguien se queje de que tarda. Lo que llegue primero.

### Diseño del Runner (Fase 2)

```
run(artefacto, entradas) →
  1. Contenedor efímero desde imagen base con Python 3.12
  2. pip install -r requirements.txt   (cacheado por hash del archivo)
  3. Montar entradas en /in, /out vacío
  4. python automatizacion.py --input /in/... --output /out/
  5. Recoger /out + stdout + código de salida
  6. Destruir el contenedor
```

Límites duros, no negociables: **sin red** (salvo que la automatización la
necesite explícitamente), 512MB RAM, 5 min de CPU, filesystem efímero. Todo lo
que se salga, se mata.

---

## 3. Máquina de estados

Una automatización solo puede estar en uno de estos estados:

La entrevista vive en su propia tabla (`intakes`, [docs/10](docs/10-intake.md));
la automatización nace al aprobar, ya en `queued`:

```
  queued ──► building ──┬──► ready ──► (archived)
                        │
                        └──► failed ──► queued  (reintento gratis)
```

| Estado | Significa | Compromete cuota |
|---|---|---|
| `queued` | Aprobado, esperando worker | **Sí** (reserva) |
| `building` | Agentes trabajando | **Sí** |
| `ready` | Usable | **Sí** |
| `failed` | No se pudo. Reintento gratis. | No — libera |
| `archived` | El cliente la borró (soft delete) | No — libera |

**La cuota se reserva al aprobar la entrevista** (con lock por organización,
[docs/10](docs/10-intake.md) §9) y se libera si el build falla o se archiva.
Si el cliente paga por un build que falló, se va.

Las ejecuciones tienen su propia máquina, más simple:
`queued → running → succeeded | failed | timeout`.

---

## 4. Trabajos en segundo plano

Un build dura minutos y debe sobrevivir a un deploy, un reinicio y un fallo de
red. Esto no es un `setTimeout`.

**Inngest** para el MVP: los jobs sobreviven deploys, tienen reintentos y
`step.run` te da checkpoints — si el build falla en el paso 4, reanuda desde
ahí en vez de repetir los pasos 1-3 (que ya costaron dinero en tokens).

El flujo real de un build:

```
1. crear sesión CMA               ← checkpoint
2. definir el outcome + rubric    ← checkpoint
3. ESPERAR el webhook de Anthropic  (minutos u horas — el worker duerme)
4. extraer artefacto de /mnt/session/outputs/
5. validar: ¿trae manifiesto? ¿corre el ejemplo?   ← puerta de calidad
6. guardar en blob, marcar ready, mandar email
```

**El paso 5 es tuyo, no del agente.** Antes de marcar `ready`, tu código corre
el artefacto contra su propio ejemplo en el Runner. Si no reproduce la salida
que el Verifier aprobó, es `failed`. Nunca confíes en que el agente diga que
funcionó — compruébalo con tu propia infraestructura.

**Nunca hagas polling esperando el build.** Registra el webhook
`session.status_idled` de CMA. Un worker bloqueado horas es un worker perdido.

---

## 5. Multitenancy y aislamiento

Tres capas, y ninguna sobra:

**Datos.** Toda tabla lleva `org_id` y toda consulta lo filtra. Si usas
Supabase, activa Row Level Security — así un bug en una query no se convierte en
una filtración entre clientes. Es la diferencia entre un incidente y una
demanda.

**Archivos.** Prefijo por organización: `s3://bucket/{org_id}/{automation_id}/`.
URLs firmadas con expiración corta. Nunca un bucket público.

**Ejecución.** Un contenedor por ejecución, destruido al terminar. Dos clientes
jamás comparten proceso. Esto ya lo da el diseño del Runner.

**Los datos del cliente son el activo más delicado que tocas.** Suben facturas,
nóminas, listas de clientes. Define desde el día uno cuánto tiempo guardas los
archivos de las ejecuciones (sugerencia: 30 días y borrado automático) y
escríbelo en la política de privacidad. Guardar todo para siempre es una
responsabilidad que no quieres.

---

## 6. Observabilidad y costos

Sin esto vuelas a ciegas y descubres que pierdes dinero cuando llega la factura.

**Registra el costo de cada build.** La tabla `versions` guarda tokens y dólares
por build. Un dashboard interno con costo por organización te dice qué cliente
te está costando más de lo que paga — y ese dato es el que ajusta el pricing.

**Alarmas que importan de verdad:**

- Un build supera $10 → cortar y marcar `failed`. Hay algo en bucle.
- Tasa de fallos > 20% en una hora → algo se rompió, avisar.
- Una organización pasa su cuota → bloquear, no facturar de sorpresa.

**Guarda la traza completa de cada build** (`build_session_id` de CMA). Cuando
un cliente diga "esto está mal", necesitas poder ver qué hizo el agente. Sin la
traza, cada queja es una investigación desde cero.

**Guardrails en cada build**, no opcionales: `task_budget` (mínimo 20k tokens),
timeout duro, y tope de iteraciones del Verifier. Un agente sin límites en un
bucle de corrección es una factura que crece sola.

---

## 7. Entornos y despliegue

| Entorno | Para qué | Modelo |
|---|---|---|
| Local | Desarrollo | Sonnet 5 (más barato mientras iteras) |
| Staging | Probar builds reales antes de soltar | Opus 4.8 |
| Producción | Clientes | Opus 4.8 |

Cada uno con su propio `environment_id` de CMA, su base de datos y su bucket.
**Nunca compartas el bucket de staging con producción** — un script de limpieza
mal apuntado borra datos de clientes reales.

Despliegue: Vercel para el frontend/API, Inngest para los workers, Neon o
Supabase para Postgres, R2 o S3 para blobs. Todo gestionado. En esta etapa no
tienes por qué operar servidores.

### Suite de regresión

Guarda 10–20 casos reales con su entrada y salida esperada. Antes de cada cambio
al prompt del Builder o al modelo, córrelos todos y compara.

**Esto es lo que te protege del riesgo más raro de este producto:** cambias una
línea del prompt del sistema, mejora en tres casos y empeora en cinco, y no te
enteras hasta que se quejan los clientes. Con software normal el código es
determinista y esto no pasa. Con agentes, sí. La suite es tu única red.

---

## 8. Lo que queda por decidir

1. **Planes y cuota.** ¿Cuántas automatizaciones por mes en cada tier? Con
   $1–5 de costo por build, un plan de 10/mes tiene $10–50 de costo variable.
   Eso pone el piso del precio.
2. **Retención de datos.** ¿Cuánto guardas los archivos de las ejecuciones?
3. **Qué pasa si el cliente cancela.** ¿Pierde las automatizaciones o las
   conserva en solo lectura? Afecta a la confianza más de lo que parece.
4. **Alcance de los procesos.** ¿Cualquier proceso, o te acotas a un dominio
   (finanzas, documentos, datos)? Acotar sube la tasa de éxito muchísimo.
