# Auditoría de la suite por MUTACIÓN — TERMINADA (2026-07-31)

**Estado (Parte 1):** ~84 corridas de mutación sobre 24 de los 38 verify. La **Parte 2** (al final de este archivo) cubre los 14 restantes: la suite queda auditada entera. **9 hallazgos, 9 arreglados y
verificados** (la mutación que sobrevivía ahora MATA), más **1 observación** sobre cómo falla
`verify:plan:pg`. **Ningún hallazgo abierto.**

### Lo que hay que leer si solo lees una cosa

Los 9 hallazgos tienen la MISMA forma: **el test valida el mecanismo por un camino y da por supuesto
el resto** — otra tabla con RLS, otra función que consulta el mismo freno, otro valor por defecto,
otro formato del mismo correo. Ninguno era un bug en el producto: eran defensas reales, bien
escritas, que **nadie estaba vigilando** — podían desaparecer en un refactor y la suite seguiría en
verde.

Los tres más graves, por si hay que priorizar:

1. **Se podía habilitar la ejecución de código de IA SIN JAULA en producción** (riesgo #1 del threat
   model del propio proyecto) sin que un solo test se quejara.
2. **El kill-switch quedaba fail-open** por el camino de la app — incluida la palanca de `cobros`,
   que el trigger no cubre en absoluto.
3. **Fuga cross-tenant invisible en 4 de las 8 tablas** con RLS, incluida la que guarda el
   `stripe_customer_id` de cada cliente.

### Zonas auditadas que salieron BIEN cubiertas

Ventana gratis de 30 días · circuit breaker de reparaciones · clasificación reparación/cambio ·
firma y anti-replay de webhooks · reintentos y arrendamiento de los drainers · clasificador de
desenlace de CMA (4 mutaciones, las 4 mueren) · purga/offboarding · política de roles y step-up ·
adaptador de intake (el bug histórico de `criterio_cliente` ya está vigilado) · off-by-one de los
topes de cuota.

**Pregunta:** no "¿pasa el producto?" sino **"¿este test fallaría si se rompiera lo que dice
vigilar?"**. Método y reglas en `NIGHT-RUN.md`. Arnés: `core/scripts/mutar.ts`.

`MATA` = el verify falló con el código roto (el test sirve). `SOBREVIVE` = siguió en verde (ciego).

## Resumen

| Mutación (qué se rompió) | Quién la MATA | Quién la deja pasar | Gravedad |
|---|---|---|---|
| **Quitar el cobro de generación** en `cobrar_build` (los builds salen gratis) | `verify:ciclo:pg` | `verify:cuota:pg`, `plan:pg`, `ajuste:pg`, `disparo:pg`, `onboarding:pg` | Media |
| Off-by-one del tope de **generaciones** (`< v_lim` → `<=`) | `verify:cuota:pg` | `ciclo:pg`, `plan:pg` | — cubierto |
| Off-by-one del tope de **ejecuciones** | `verify:cuota:pg` | — | — cubierto |
| **RLS de `automatizaciones` → `USING (true)`** | `verify:pg`, `lectura:pg` | `http` (benigno) | — cubierto |
| **RLS de `subscriptions` → `USING (true)`** (fuga del `stripe_customer_id`) | `verify:cuenta:pg` | **`verify:pg`** | **Alta** ✅ arreglado |
| **RLS de `uso_periodo` → `USING (true)`** | `verify:cuenta:pg` | **`verify:pg`** | **Alta** ✅ arreglado |
| RLS de `invitaciones` / `ejecuciones` → `USING (true)` | (nadie, antes) | **`verify:pg`** | **Alta** ✅ arreglado |
| **`MAX_AJUSTES = 3` → `99`** (el tope de ajustes del plan) | `verify:ciclo` (unit) | **`verify:ciclo:pg`**, `ajuste:pg` | **Alta** ✅ arreglado |
| Invertir `clasificar()` (reparaciones cobran, cambios gratis) | `ciclo`, `ciclo:pg`, `ajuste:pg` | — | — cubierto |
| Ventana gratis 30 días → 0 / 3000 días | `verify:ventana:pg`, `ciclo:pg` | — | — cubierto |
| Circuit breaker de reparaciones: nunca engancha | `verify:reparaciones:pg` | — | — cubierto |
| **Desactivar el tope de zip-bomb** (`maxEntradas`, `maxDescomprimido`) | (nadie) | `entrada`, `entrada:gate` | **Alta** ✅ arreglado |
| **Desactivar el tope de tamaño** de archivo y de lote | (nadie) | `entrada`, `entrada:gate` | **Alta** ✅ arreglado |
| Desactivar el tope de pixel-flood | `verify:entrada` | — | — cubierto |
| **`permitirEnProduccion: false` → `true`** (código de IA sin jaula en producción) | (nadie) | toda la suite | **Crítica** ✅ arreglado |
| **Ventana de step-up 5 min → 1 año** (cookie robada privilegiada 12 meses) | (nadie) | `verify:http` | **Alta** ✅ arreglado |
| Límites por defecto del Run (`timeoutMs`, `outMaxFiles`) sin tope | (nadie) | `verify:sandbox` | Media ✅ arreglado |
| Ventana anti-replay de firma de webhook 5 min → 10 años | `verify:webhooks` | — | — cubierto |
| Tope de reintentos de los drainers (3 → 1M) | `disparo:pg`, `ajuste:pg` | — | — cubierto |
| Arrendamiento de la cola 15 min → 0 (doble cobro del mismo build) | `verify:disparo:pg` | — | — cubierto |
| **Quitar el write-once de `app_stripe_vincular`** (la org cambia de customer) | (nadie) | `verify:stripe:pg` | **Alta** ✅ arreglado |
| Downgrade: no desactivar el excedente / conservar las más nuevas | `verify:plan:pg` **pero COLGÁNDOSE** | — | ver observación |
| **`verificar_freno` fail-OPEN** sin fila de `interruptores` (kill-switch inerte) | (nadie) | `verify:killswitch:pg` | **Alta** ✅ arreglado |
| Kill-switch: fail-open del TRIGGER / suspensión por-org desactivada | `verify:killswitch:pg` | — | — cubierto |
| **Quitar `lower(btrim())` del correo entrante** (la invitación no cruza nunca) | (nadie) | `verify:onboarding:pg` | **Media** ✅ arreglado |
| Invitación: no borrarla antes de crear la membresía (lugar contado doble) | `verify:onboarding:pg` | — | — cubierto |

## Hallazgo 1 — `verify:pg` probaba el aislamiento de UNA tabla de ocho ✅ ARREGLADO

`verify:pg` es *el* test de aislamiento entre clientes. Ejercitaba cross-org solo sobre
`automatizaciones`. De las 8 tablas con RLS, **nunca tocaba `invitaciones`, `ejecuciones`,
`subscriptions` ni `uso_periodo`**.

Demostrado: poniendo `USING (true)` en la política de `subscriptions` —la tabla que lleva el
`stripe_customer_id` de cada cliente— `verify:pg` seguía **en verde**. Lo cazaba `verify:cuenta:pg`
de rebote, o sea que el aislamiento de media base dependía de un test que mira otra cosa. Si ese
test cambiara de forma, la fuga pasaría sin que nadie se enterara.

**Por qué no se veía:** el test comprobaba el *mecanismo* (¿RLS aplica? ¿el rol es seguro? ¿`conOrg`
acota?) con una tabla de muestra, asumiendo que lo demás va solo. La política, sin embargo, se
declara **tabla por tabla**: olvidar una no rompe nada visible.

**Arreglo** (`verify:pg` §5): recorre las tablas con RLS **leídas de `pg_class`, no de una lista a
mano** —una tabla nueva entra sola— y afirma que desde la org B no se ve ninguna fila de A. Siembra
una fila de A en cada una: sin fila que ocultar, un `USING (true)` no se distingue de uno correcto
(0 filas por vacío, no por aislamiento). Añade `sin_politica` (RLS activo sin política) y un check
explícito de que el `stripe_customer_id` de A es invisible desde B.

Verificado: las cuatro mutaciones que antes sobrevivían ahora **MATAN**.

## Hallazgo 2 — `verify:cuota:pg` probaba el contador, no el cobro ✅ ARREGLADO

Quitando entera la línea que cobra la generación al arrancar un build (`PERFORM app_consumir(…,
'generaciones')` en `cobrar_build`), `verify:cuota:pg` seguía en verde: los builds saldrían **gratis
e ilimitados** y el test de cuota no se enteraba. Lo cazaba `verify:ciclo:pg` de rebote.

**Por qué:** el test llamaba a `consumirGeneracion(...)` —el contador— directamente, nunca al camino
que corre de verdad. Insertar una versión es lo que dispara el trigger, y eso no se ejercitaba.

Mismo patrón que el hallazgo 1: el test que *posee* el tema valida la pieza pero no el camino, y la
red está en otro test por accidente.

**Arreglo** (`verify:cuota:pg` §6bis): insertar una versión debe cobrar exactamente una generación,
y una `reparacion` por ese mismo camino debe seguir exenta (docs/08 §2). Verificado: ambas
mutaciones ahora MATAN.

## Hallazgo 3 — el tope de ajustes está declarado dos veces y nada comprobaba que coincidieran ✅ ARREGLADO

`MAX_AJUSTES = 3` (TS) y `CHECK (ajustes_usados <= 3)` (SQL) son la MISMA regla de negocio escrita
en dos sitios. Poniendo `MAX_AJUSTES = 99`, `verify:ciclo:pg` seguía en verde — pese a que su propio
check se llama *"CHECK ajustes_usados<=3 (== MAX_AJUSTES)"*: el nombre afirmaba una relación que el
código no comprobaba, porque hardcodeaba el `4`.

**Qué pasaría en producción:** alguien decide dar 5 ajustes y cambia la constante. La app dejaría
pedir el 4º y el 5º, y la BD los rechazaría con una violación de constraint cruda — el cliente vería
un 500 en vez de "ya usaste tus ajustes". Al revés (bajar el CHECK) los agotaría antes de tiempo.

**Arreglo:** el check ahora deriva del propio `MAX_AJUSTES` (importado), prueba los dos lados
—`MAX_AJUSTES + 1` debe violar y `MAX_AJUSTES` debe entrar— y así falla si cualquiera de las dos
declaraciones se mueve sin la otra. Verificado: `MAX_AJUSTES = 99` ahora MATA.

## Hallazgo 4 — el gate probaba que SABE bloquear, no que ESTÉ configurado para bloquear ✅ ARREGLADO

El gate de entrada es la defensa contra archivos hostiles (docs/11 §4bis: XXE, zip-bomb,
pixel-flood, spoofing). Sus tests son buenos… pero **cada caso inyecta límites pequeños**
(`lim({ maxBytesArchivo: 100 })`, `lim({ zip: {...} })`) para poder disparar el rechazo con
fixtures diminutos. Nadie ejercitaba los valores **por defecto**, que son justo los que corren en
producción (`gatearArchivoBytes(...)` los toma de `LIMITES`).

Resultado: subiendo `zip.maxEntradas` a 10 millones, `zip.maxDescomprimido` a 900 GB,
`maxBytesArchivo` a 900 GB o `lote.maxArchivos` a 10 millones, **la suite entera seguía en verde**.
Se podía desarmar la defensa contra zip-bombs y subidas gigantes sin que un solo test se quejara.
De los cinco topes, solo el de pixel-flood estaba cubierto.

**Arreglo** (`verify:entrada` §7): dos cosas distintas, porque prueban cosas distintas —
(a) que cada default siga en un rango sensato, y (b) el comportamiento **sin inyectar nada**: un ZIP
con `maxEntradas + 1` entradas y un lote con `maxArchivos + 1` archivos deben rechazarse con la
configuración real. La (b) es la que demuestra que el número no es decorativo.

Verificado: las cinco mutaciones que antes sobrevivían ahora **MATAN**.

## Hallazgo 5 — se podía habilitar la ejecución SIN JAULA en producción y nadie se enteraba ✅ ARREGLADO

`LocalPythonExecutor` no aísla red, FS ni kernel: es el puente de desarrollo. Lo único que impide
que corra en producción es `permitirEnProduccion: false` por defecto más el chequeo de `NODE_ENV`.

Cambiando ese default a `true`, **la suite entera seguía en verde**. O sea: se podía habilitar la
ejecución sin jaula de código generado por IA, en producción y multi-tenant, sin que un solo test
se quejara. Es el riesgo #1 del threat model del propio proyecto (docs/11, escape de contenedor) y
no tenía ni una línea de test.

**Arreglo** (`verify:sandbox` §6): con `NODE_ENV=production`, construirlo sin la bandera debe lanzar;
la bandera explícita sigue siendo la única salida; y el default es `false`. Más §7 con los límites
por defecto del Run —mismo patrón del hallazgo 4: los casos existentes inyectan límites chicos para
poder cortar en segundos, así que los valores reales nunca se ejercitaban.

Nota: para poder afirmar los defaults hubo que **exportar `LIMITES_DEFAULT`** (antes era privado del
módulo). Es el único cambio a código de producción de toda la auditoría, y es de una palabra.

## Hallazgo 6 — la ventana de step-up MFA no estaba pinchada por ningún test ✅ ARREGLADO

`VENTANA_STEPUP_MS = 5 min` decide cuánto vale una re-verificación de MFA. Ensanchándola a **un
año**, `verify:http` seguía en verde: una cookie robada seguiría siendo privilegiada 12 meses para
invitar gente, quitar admins o tocar facturación.

**Por qué no se veía:** los tres casos que había eran MFA *ausente*, MFA *fresco* y MFA *en el
futuro*. Ninguno compara realmente contra la ventana — ausencia y futuro fallan antes de llegar ahí.
Faltaba el caso obvio: **presente pero viejo**.

**Arreglo:** dos identidades nuevas que fijan los dos bordes — 6 min (fuera, debe dar 403) y 4 min
(dentro, debe pasar). Así se caza tanto ensanchar como encoger la ventana. Verificado con las dos
mutaciones.

## Hallazgo 7 — la org podía cambiar de customer de Stripe y nadie lo notaba ✅ ARREGLADO

`app_stripe_vincular` es write-once por dos razones distintas, y solo una estaba probada. El test
cubría *"el customer pertenece a OTRA org"* (`STRIPE_CUSTOMER_DE_OTRA_ORG`), pero no *"la org ya
tiene OTRO customer"* (`STRIPE_ORG_YA_TIENE_CUSTOMER`). Quitando ese segundo `IF`,
`verify:stripe:pg` seguía en verde.

**Qué pasaría:** el `stripe_customer_id` de la org se re-apunta al customer nuevo, y **todos** los
eventos del viejo —pagos, fallos, cancelaciones— pasan a ser no-op silenciosos, porque
`resolver_org_stripe` ya no los mapea. Es exactamente el bug que este proyecto ya sufrió cuando
`stripe_customer_id` no tenía escritor: Stripe cobrando y el producto sin enterarse de nada.

**Arreglo** (`verify:stripe:pg` §3bis): un checkout con otro customer sobre una org ya vinculada
debe fallar, la org debe seguir con el original, el customer nuevo no debe quedar mapeado a nadie —
y re-vincular el MISMO customer debe seguir siendo idempotente (un webhook duplicado no puede
romper). Verificado: la mutación ahora MATA.

## Hallazgo 8 — el kill-switch quedaba FAIL-OPEN por el camino de la app ✅ ARREGLADO

`interruptores` es una tabla de UNA fila. Si falta (BD a medias, alguien la borra durante un
incidente), `verificar_freno` debe considerar el servicio FRENADO — `coalesce(v_congelado, true)`.
Cambiando ese `true` por `false`, `verify:killswitch:pg` seguía en verde.

**Por qué no se veía:** el test SÍ tenía una sección de fail-closed, pero la probaba disparando un
build y un run, que pasan por el **TRIGGER** de la BD. La función `verificar_freno` es el OTRO
camino — el guard temprano del Run (`ejecutarEP`) y el checkout de Stripe
(`exigirCobrosActivos`) — y ese nunca se ejercitaba sin la fila. Peor: la palanca **`cobros` solo
existe en esa función**; el trigger no la cubre en absoluto.

Un kill-switch que se vuelve inerte justo cuando la BD está a medias es lo contrario de un
kill-switch.

**Arreglo** (`verify:killswitch:pg` §6): sin la fila, `verificar_freno` debe bloquear las tres
palancas, y `exigirCobrosActivos` también. Se afirma sobre el error **traducido**
(`ServicioSuspendido` + motivo), que es el contrato del que dependen los llamadores, no sobre el
texto crudo de Postgres.

Nota de método: al escribir este check falló SIN mutación, y la regla del brief es no "arreglarlo"
cambiando el test. Al investigar resultó ser **mi aserción** (esperaba el mensaje crudo de SQL, pero
`verificarFreno` lo convierte con `comoSuspension()`), no un bug del producto. Comprobado antes de
concluir, en ambas direcciones.

## Hallazgo 9 — un correo con mayúsculas rompía la invitación en silencio ✅ ARREGLADO

`app_aceptar_invitaciones` normaliza el correo entrante con `lower(btrim(...))` antes de cruzarlo
con `invitaciones`. Quitando esa normalización, `verify:onboarding:pg` seguía en verde.

**Qué pasaría:** las invitaciones se guardan en minúsculas (el esquema del endpoint las normaliza),
pero el correo que llega de Clerk al registrarse **no tiene por qué venir normalizado**. Si viene
como `Ana@Vitrales.MX`, el cruce falla: la persona se registra, **no entra al equipo**, se le crea
una org propia, y su lugar del plan sigue ocupado para siempre. Nadie recibe un error.

Es exactamente la clase de bug que este proyecto ya sufrió dos veces con las invitaciones (el
`user_id` inventado del local-part; la invitación que solo servía si la persona nunca se había
registrado).

**Arreglo** (`verify:onboarding:pg` §7bis): se invita en minúsculas y se registra con
`"  Mayus.Prueba@Ejemplo.MX  "` — debe entrar igual, con su rol, consumiendo la invitación y sin
recibir org propia. Verificado: la mutación ahora MATA.

## Observación — `verify:plan:pg` se colgaba en vez de fallar ✅ ARREGLADO

Dos mutaciones del downgrade (no desactivar el excedente; conservar las más nuevas en vez de las más
antiguas) **no hacían fallar** a `verify:plan:pg`: lo dejaban colgado para siempre. En CI eso es
peor que un fallo — bloquea el pipeline en vez de reportar, y se llevó por delante dos tandas de
esta auditoría.

**La causa NO era un lock**, aunque lo parecía. El primer intento de arreglo fue poner
`lock_timeout`/`statement_timeout`… y las mutaciones siguieron colgándose. Instrumentando dónde se
quedaba, salió lo de verdad: al romper el downgrade sobran automatizaciones activas, así que
`reactivar(t1, …)` lanza `CuotaExcedida` **con la transacción abierta**. Ese cliente nunca vuelve al
pool, y `pool.end()` en el `finally` espera a que TODOS vuelvan: se queda esperando para siempre.
Nadie estaba esperando un lock; el proceso estaba esperando a cerrar el pool.

**Arreglo:** `try/finally` alrededor de las transacciones de las secciones 5 y 6 (se cierran pase lo
que pase, con `ROLLBACK` idempotente tras un `COMMIT` ya hecho) y un `Promise.race` con tope de 3 s
en el cierre de pools. Se conservan además `lock_timeout = 5s` y `statement_timeout = 20s` en cada
conexión: no eran la causa de ESTE cuelgue, pero sí cubren el caso de una espera real por lock, que
en un test que toma advisory locks a propósito es un riesgo verosímil.

Verificado: las dos mutaciones ahora **MATAN en ~1 s** en vez de colgar 180.

Lección: **un timeout que no ataca la causa da la falsa sensación de haber arreglado.** Si el primer
intento no cambia el síntoma, hay que instrumentar dónde se cuelga en vez de subir el tope.

`mutar.ts` corta a los 180 s y reporta `SE CUELGA` como categoría propia — ni MATA ni SOBREVIVE.

## Notas de método

- Casi todo el cobro y todo el aislamiento viven en **SQL**, no en TypeScript. Mutar `schema.sql` no
  surte efecto si no se reaplica: por eso `mutar.ts` tiene modo `--sql`. Sin él la auditoría del
  camino del dinero habría dado "MATA" en todo, por error — la peor forma de fallar.
- El modo `--sql` solo es fiable en `CREATE OR REPLACE FUNCTION` y en las políticas (que se hacen
  `DROP` + `CREATE`), que son los objetos que el esquema **recrea** al aplicarse.
- ⚠️ **Cuidado con los hallazgos FANTASMA.** Mutar algo dentro de un `CREATE TABLE` da un
  "SOBREVIVE" **falso**: el esquema usa `CREATE TABLE IF NOT EXISTS` y sobre una tabla que ya existe
  no hace nada, así que la mutación nunca llega a la BD y el verify pasa por la razón equivocada.
  Pasó auditando el tope de ajustes (`CHECK … <= 3` → `<= 99` daba SOBREVIVE mientras la BD seguía
  con el 3). `mutar.ts` ahora lo detecta y reporta `INCONCLUSO`. Sin esa guarda, media auditoría del
  esquema habría sido humo. Para probar un constraint hay que mutarlo con `ALTER TABLE … DROP/ADD
  CONSTRAINT` o recrear la BD desde cero.
- **Un test que inyecta su propia configuración prueba el mecanismo, no el sistema.** Es el patrón
  del hallazgo 4 y conviene buscarlo en otros sitios: si el test pasa `lim`/`opts`/`deps` a medida,
  los valores reales de producción quedan sin ejercitar.
- `verify:http` sobrevive a las mutaciones de RLS y **no es un hallazgo**: su guarda de membresía
  (capa 6) corta el cross-org antes de que RLS entre en juego. Es lo que ese test debe probar.

## Qué queda (nada bloqueante)

1. **14 de los 38 verify sin auditar a fondo** — los de menor valor: `incidentes:pg`, `storage`,
   `pgstate:pg`, `adaptador:pg`, `entrada:gate`, `webhooks:handlers:pg`, `ejecutar:pg`, `rutas`,
   `notificaciones`, `cuenta:pg`, `lectura:pg` (parcial), `cma`, y los unit de `ciclo`/`cuota`.
   El arnés queda listo para retomarlos: `npx tsx scripts/mutar.ts [--sql] <archivo> <buscar>
   <reemplazar> <verify>`.
2. **Nada que decidir.** Los 9 hallazgos están cerrados y verificados; no hay preguntas abiertas.

## Cómo revisar esto

```
git diff main..auditoria-suite
```

9 commits, uno por hallazgo, cada uno explicando qué se rompió y por qué el test no lo vio. El
**único** cambio a código de producción en toda la auditoría es de una palabra: exportar
`LIMITES_DEFAULT` (`core/src/run/executor.ts`) para poder afirmar los límites por defecto. Todo lo
demás son tests.

---

# PARTE 2 — los 14 verify que faltaban (2026-07-31)

**Estado:** los 38 verify quedan auditados por mutación. Esta segunda tanda cubrió los 14 que la
primera había dejado fuera por bajo valor esperado. **111 mutaciones · 96 supervivientes · 15
descartados por cruce · 53 sometidos a refutación · 13 hallazgos graves confirmados.**

## Por qué el número que importa es 13 y no 96

Tres filtros, cada uno tumbó una parte. Los tres son necesarios: sin ellos este documento diría
"96 hallazgos, 27 críticos", que es falso.

| Filtro | Antes | Después | Qué tumbó |
|---|---|---|---|
| Ejecutar la mutación | 111 propuestas | 96 sobreviven | 15 las mata el verify al que apuntaban |
| **Cruce contra el resto de la suite** | 96 | 81 ciegas | 15 las mata OTRO verify |
| **Refutación adversarial** | 53 graves | 13 graves reales | 13 falsos + 25 inflados + rebajas |

**El cruce es el filtro que la Parte 1 sí tenía y esta corrida no.** `mutar.ts` corre UN verify: que
una mutación sobreviva a `verify:cuenta:pg` no dice que la suite sea ciega. Se reejecutó cada
superviviente contra todos los verify cuyo cierre transitivo de imports incluye el archivo mutado
(509 corridas, con corte al primer MATA). 15 murieron ahí. Casi todas eran mutaciones de
`schema.sql` que `verify:pgstate:pg` no ve pero `verify:pg` sí.

**La refutación invirtió la carga de la prueba.** La gravedad la había puesto el mismo agente que
propuso la mutación, y nadie juzga bien su propia hipótesis. Once escépticos independientes, con
posición por defecto "INFLADO", tenían que demostrar dos cosas para sostener un hallazgo: que el
código es alcanzable en producción, y que ninguna otra capa detiene el daño. Resultado: **48 de 53
rebajados, ninguno subido.**

Los dos motivos de refutación que más pesaron, y que conviene recordar antes de creerse el próximo
hallazgo:

- **No es código de producción.** `core/src/storage/local.ts` (path traversal) solo se usa en dev:
  el wiring real devuelve `LocalStorage` dentro de `if (DEV)`. `entitlementsDe`, `esPlan` y
  `resolverIncidente` no tienen NI UN llamador fuera de los tests. Cuatro "críticas" cayeron aquí.
- **Otra capa detiene el daño.** El gate de entrada ya corre dos veces antes y después del punto
  mutado; `FORCE ROW LEVEL SECURITY` solo afecta al dueño de la tabla, no al rol de app.

## Lo que hay que leer si solo lees una cosa

Los 13 confirmados se agrupan en **cuatro huecos**, no trece problemas sueltos:

1. **El auditor de rutas (`verify:rutas`) se evade con refactors normales** — 5 hallazgos. Su regex
   solo reconoce `export const POST = ruta(...)`: comentar la línea y escribir el handler debajo,
   o usar `export { POST }`, lo hace invisible. Y las exenciones de webhooks y crons se conceden
   por RUTA, no por comprobar que el archivo delegue de verdad. Un `route.ts` sin las 8 capas pasa
   el CI. Aquí caen `/webhooks/stripe` (fuente de verdad del plan, sin firma) y `/cron/disparo`
   (drena la cola con el pool dueño y gasta ~$1.8 por build).
2. **La cosecha entrega builds que no existen** — 3 hallazgos en `cma/build.ts` y `handlers.ts`.
   Incluye el único **crítico**: cruzar `version_id`/`auto_id` al encolar deja a TODOS los clientes
   pagando sin recibir nada, mientras el cron reporta `cosechados>0`.
3. **El Run puede correr la versión equivocada** — 2 hallazgos. Sin `a.activa` una automatización en
   solo-lectura tras un downgrade sigue ejecutándose; con `ORDER BY numero ASC` el cliente que pagó
   un ajuste recibe para siempre el reporte VIEJO con datos frescos. Resultado incorrecto
   silencioso: el peor modo de falla que hay.
4. **CSRF por prefijo** — 1 hallazgo. `===` a `startsWith` y `automata.mx.evil.com` pasa la capa 2.
   Los dos únicos fixtures hostiles de la suite son `https://evil`, que no ejerce ese caso.

## Los 13 hallazgos confirmados

### 1. [CRITICA] `verify:webhooks:handlers:pg` — `src/webhooks/handlers.ts`

**Mutación que sobrevive a TODA la suite:**

```
[evento.recurso.sessionId, v.version_id, v.auto_id, v.org_id],
→
[evento.recurso.sessionId, v.auto_id, v.version_id, v.org_id],
```

**Qué se rompe:** El outbox de cosecha se llena con la version/auto REALES que devolvio el resolver FIRMADO. El test solo cuenta filas (`count(*)=1` en cosecha_pendiente) y nunca compara version_id/auto_id contra la version sembrada: valida el mecanismo por la dimension existencia y da por supuesto el contenido.

**Camino de daño (verificado por un escéptico independiente):** CMA manda `session.status_idled` → el handler encola en cosecha_pendiente con version_id/auto_id cruzados → el cron de cosecha no encuentra la versión, reporta 'cosechado' y borra el outbox → la versión real se queda 'building' para siempre → a las 6 h el reaper la marca 'failed'. Le pasa a TODOS los builds: cada cliente paga (~$1.8 de costo) y no recibe nada, mientras el cron reporta cosechados>0.

**Nota del juicio:** Verificado punta a punta. El INSERT está en core/src/webhooks/handlers.ts:71-74 y `cosecha_pendiente` NO tiene FK ni CHECK (core/db/schema.sql:326-333: version_id y auto_id son `uuid NOT NULL` a secas), así que Postgres acepta el intercambio en silencio — ninguna capa de BD lo ve. Aguas abajo, `drenarCosecha` construye el ItemCosecha desde esas columnas (cosecha.ts:130) y `cosecharYConfirmar` hace `SELECT vista, estado FROM versiones WHERE id=$1 AND org_id=$2` (cosecha.ts:64); con el auto_id en lugar del version_id no hay fila y la función devuelve 'cosechado' (`if (!row) return "cosechado"`, :66), con lo que el drainer BORRA la fila del outbox y la cuenta como éxito (:135-137). El verify qu

---

### 2. [ALTA] `verify:adaptador:pg` — `src/http/pipeline.ts`

**Mutación que sobrevive a TODA la suite:**

```
if (s.origen === undefined || s.hostEsperado === undefined || s.origen !== s.hostEsperado) {
→
if (s.origen === undefined || s.hostEsperado === undefined || !s.origen.startsWith(s.hostEsperado)) {
```

**Qué se rompe:** Capa 2 (CSRF): el Origin de toda mutación debe ser IGUAL al origen propio. Con startsWith, 'https://app.evil.com' y 'https://app-evil.mx' pasan como si fueran nuestros.

**Camino de daño (verificado por un escéptico independiente):** Atacante registra un dominio cuyo origen tiene APP_ORIGIN como prefijo (p.ej. 'automata.mx.evil.com' o 'app.automata.mx.attacker.io') → un admin logueado visita su página → la página dispara POST /orgs/:orgId/construir (~$1.8 por build), DELETE de miembros, POST /pagar o /ajustar → la capa 2 acepta el Origin porque `startsWith` da true → la petición pasa a rate/authn ya sin defensa CSRF propia. El único freno que queda es que el navegador no adjunte la cookie __session por SameSite=Lax; el paso de step-up cubre invitar/quitar/facturación pero NO construir/ajustar/ejecutar, que es justo el camino del dinero.

**Nota del juicio:** Es la capa 2 del pipeline real (core/src/http/pipeline.ts:70-74), y la cruzan TODAS las mutaciones: los endpoints JSON vía withEfecto y las subidas binarias vía adaptarUpload, ambos con `hostEsperado: cfg.appOrigin` poblado por el adaptador (core/src/http/adaptador.ts:87 y :126) y `origen: req.headers.get('origin')`. Un comparador por prefijo sobre un Origin completo es explotable de forma trivial: con APP_ORIGIN='https://automata.mx', el origen 'https://automata.mx.evil.com' empieza con él y pasa. Y la mutación sobrevive porque los dos únicos fixtures hostiles de la suite son 'https://evil' (verify-http.ts:70) y 'https://evil' (verify-adaptador-pg.ts §5), ninguno con el origen propio como p

---

### 3. [ALTA] `verify:ejecutar:pg` — `src/pipeline/run.ts`

**Mutación que sobrevive a TODA la suite:**

```
WHERE v.automatizacion_id = $1 AND a.activa
→
WHERE v.automatizacion_id = $1
```

**Qué se rompe:** Una automatizacion en solo-lectura (activa=false, el excedente que deja aplicarDowngrade al bajar de plan) NO se puede ejecutar. El comentario justo arriba del query dice literalmente que el JOIN con automatizaciones y el a.activa 'NO son decorado' y que sin eso el downgrade no le quitaba nada al cliente.

**Camino de daño (verificado por un escéptico independiente):** Cliente en Equipo ($1,999, 10 espacios) baja a Base ($499, 3 espacios) → Stripe manda customer.subscription.updated → aplicarDowngrade deja 7 automatizaciones en activa=false → el cliente entra a /portafolio, la tarjeta sigue ahí y el botón Ejecutar sigue vivo → sin `a.activa` el query resuelve la versión y corre. No hace falta atacante ni URL a mano: es el usuario honesto. El daño está ACOTADO por app_consumir('ejecuciones'), que ya usa el plan nuevo (500/mes en base vs 10000 en equipo), así que no es ilimitado: lo que se fuga es el diferenciador de ESPACIOS (10 automatizaciones por el precio de 3), ~$1,500 MXN/mes por cliente que baje de plan. Por eso alta y no crítica: es fuga de ingreso, no brecha de datos, y el volumen sigue topado.

**Nota del juicio:** El `a.activa` es la ÚNICA aplicación del estado solo-lectura en el camino del Run. Lo verifiqué en las tres capas que podrían salvarlo y ninguna lo hace: (1) los triggers del INSERT en `ejecuciones` son `trg_kill_run` (verificar_kill_switch, core/db/schema.sql:1144-1146) y `trg_presupuesto_run` (cobrar_ejecucion, schema.sql:1154-1164) — ninguno mira `automatizaciones.activa`; (2) RLS solo acota por org, no por activa; (3) el front NO gatea: no hay una sola referencia a `activa` en web/app/portafolio/** fuera de una variable local de UI (portafolio/[id]/page.tsx:434 es otra cosa). El escritor de activa=false es `aplicarDowngrade` (core/src/billing/plan.ts:54-62), llamado de verdad en producci

---

### 4. [ALTA] `verify:ejecutar:pg` — `src/pipeline/run.ts`

**Mutación que sobrevive a TODA la suite:**

```
ORDER BY v.numero DESC LIMIT 1
→
ORDER BY v.numero ASC LIMIT 1
```

**Qué se rompe:** El Run dispara la version ejecutable MAS RECIENTE (la vigente), no cualquiera. Es lo que hace que un ajuste ya entregado (v2/v3) sea el que corre.

**Camino de daño (verificado por un escéptico independiente):** Cliente pide un ajuste (POST /ajustar, ya probado con dinero real: la v3 con columnas nuevas), se le cobra uno de sus 3 cambios, el drainer entrega la v2 'lista' → toda ejecución posterior vuelve a correr la v1. La UI dice 'lista', no hay excepción, no hay 500: el cliente recibe el reporte VIEJO con datos frescos — resultado incorrecto silencioso, el peor modo de falla. Se queda en alta y no crítica porque es auto-delatante: el cliente pidió columnas concretas y verá que no están, así que el daño se detecta en la primera corrida en vez de acumularse en silencio.

**Nota del juicio:** El fixture de verify-ejecutar-pg.ts inserta UNA sola versión por automatización (numero=1: líneas 74, 77, 78), así que DESC y ASC son indistinguibles y el test no fija nada. El propio docstring de la función promete la garantía en texto (core/src/pipeline/run.ts:46: «Dispara la versión ejecutable más reciente»), o sea que la garantía no es inventada por el proponente. Ninguna otra capa elige versión: el artefacto se carga por `version.id` y no hay chequeo de vigencia en build-pipeline ni en el wiring; `ejecutarAutomatizacion` no tiene otro llamador. CORRIJO al proponente en un punto: el reintento gratis NO se rompe. El WHERE filtra `estado IN ('ready','lista')`, y en ese escenario la v1 qued

---

### 5. [ALTA] `verify:rutas` — `../web/app/api/orgs/[orgId]/miembros/route.ts`

**Mutación que sobrevive a TODA la suite:**

```
export const DELETE = ruta(quitarMiembroEP);
→
export async function DELETE(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  const { userId } = (await req.json()) as { userId: string };
  await quitarMiembroDirecto(orgId, userId); // sin autorizar(): sin rol admin, sin step-up, sin CSRF
  return Response.json({ ok: true });
}
```

**Qué se rompe:** 'Todo verbo mutante pasa por un camino sancionado'. El DELETE deja de ir por ruta() y expulsa gente sin las 8 capas. El test NO lo ve por un fallo REAL de su lógica 'envuelta': `cuerpo` se calcula con `export function DELETE...[\s\S]*` (greedy HASTA EL FINAL DEL ARCHIVO), así que arrastra el cuerpo del POST de más abajo, donde vive `await invitar(req, ctx)` — e `invitar` está en `ligados`. El DELETE hereda la sanción de OTRO handler.

**Camino de daño (verificado por un escéptico independiente):** Alguien añade a miembros/route.ts un DELETE/PUT propio (el archivo ya invita a ello: documenta el patrón «envuelto» para efectos posteriores) → CI verde → en producción ese verbo no pasa por autorizar(): sin rate-limit, sin authn, sin CSRF, sin assertCan('quitar_gente'=admin+step-up) y sin validar el orgId de la URL contra la membresía. RLS no salva: el propio handler fija app_current_org con el orgId que viene en la ruta. Resultado: expulsión de miembros cross-org. El daño es CONDICIONADO a que alguien escriba ese handler — por eso alta y no crítica: hoy no hay ningún handler así en el árbol, el agujero es del detector.

**Nota del juicio:** Reproduje la lógica del escáner fuera de la suite (sin BD) y el fallo es exactamente el descrito: para DELETE, `viaRutaDirecta`=false pero `cuerpo` = /export\s+(?:async\s+)?function\s+DELETE\b[\s\S]*/ es GREEDY hasta el fin del archivo (core/scripts/verify-rutas.ts, cálculo de `cuerpo`/`viaRutaEnvuelta`), arrastra el POST de abajo donde vive `await invitar(req, ctx)`, e `invitar` está en `ligados` → viaRutaEnvuelta=true → check VERDE. Es un falso verde, no una omisión. Y no hay red de seguridad en runtime: web/middleware.ts excluye /api explícitamente («la API se autentica en el pipeline»), así que `ruta()` es TODA la puerta. Las guardas propias del endpoint (no dejar la org sin admin) viven

---

### 6. [ALTA] `verify:rutas` — `../web/app/api/orgs/[orgId]/construir/route.ts`

**Mutación que sobrevive a TODA la suite:**

```
export const POST = ruta(solicitarBuildEP);
→
// export const POST = ruta(solicitarBuildEP);  ← desactivado: el pipeline consume el cuerpo
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  return Response.json(await encolarBuildDirecto(orgId, await req.json()));
}
```

**Qué se rompe:** Misma garantía, rota por el refactor MÁS común que existe: comentar la línea vieja y escribir el handler nuevo debajo. `viaRutaDirecta` es la regex textual `POST\s*=[^\n]*\bruta\s*\(` sobre el archivo ENTERO — un comentario la satisface igual que código vivo. El escáner no distingue código de prosa.

**Camino de daño (verificado por un escéptico independiente):** Se comenta `export const POST = ruta(solicitarBuildEP)` y se escribe un POST propio → CI verde → POST /orgs/:orgId/construir queda sin autorizar(): sin authn, sin CSRF, sin rate-limit y sin validar que el orgId de la URL sea de tu membresía. Ese endpoint encola builds de ~$1.8 reales que consumen cuota de generaciones. La única barrera que quedaría es cobrar_build/app_consumir, que topa el gasto al plan pero NO impide que lo queme un tercero ni un operador. Alta y no crítica por la misma razón que el 12: el daño necesita que alguien haga ese refactor; lo que está roto hoy es el detector.

**Nota del juicio:** Confirmado mecánicamente: `viaRutaDirecta` = /POST\s*=[^\n]*\bruta\s*\(/ corre sobre el ARCHIVO ENTERO sin quitar comentarios, así que la línea vieja comentada (`// export const POST = ruta(solicitarBuildEP);`) la satisface igual que código vivo → check VERDE. De los tres agujeros de verify:rutas éste es el de mayor alcance: no depende de la forma del archivo, aplica a los 11 route.ts que hoy usan `= ruta(`, y el gesto que lo dispara (comentar la línea vieja y escribir el handler nuevo debajo) es el refactor más común que existe. Sin runtime que respalde: web/middleware.ts deja /api sin proteger a propósito.

---

### 7. [ALTA] `verify:rutas` — `../web/app/api/orgs/[orgId]/ajustar/route.ts`

**Mutación que sobrevive a TODA la suite:**

```
export const POST = ruta(pedirAjusteEP);
→
const POST = async (req: Request, ctx: { params: Promise<{ orgId: string }> }) => {
  const { orgId } = await ctx.params;
  return Response.json(await encolarAjusteDirecto(orgId, await req.json()));
};
export { POST };
```

**Qué se rompe:** Misma garantía, evadida por SINTAXIS de export. El detector es `export\s+(?:const|async\s+function|function)\s+POST\b`; `export { POST }` (re-export de un binding, que Next.js 16 honra igual como handler de ruta) no casa, así que `exporta` es false y el archivo se salta ENTERO con `continue` — ni siquiera se emite un check. El anti-olvido tiene un punto ciego en su propia detección de handlers.

**Camino de daño (verificado por un escéptico independiente):** Cualquier route.ts nuevo escrito con `export { POST }` (o `export { h as POST }`) desaparece del escáner entero: el verify cuyo propósito declarado es «que añadir un camino nuevo obligue a pasar por aquí» no ve el camino nuevo. Si ese handler no llama a ruta(), llega a producción sin las 8 capas — en /ajustar concretamente se pierde assertCan('ajustar'=admin), el CSRF y la validación por esquema de `confirmado:true`, o sea gastar uno de los 3 ajustes del cliente sin que lo haya confirmado. Alta, no crítica: igual que 12 y 13, el daño requiere un handler futuro; lo roto hoy es la detección.

**Nota del juicio:** Confirmado: el detector `export\s+(?:const|async\s+function|function)\s+POST\b` da false con `export { POST }`, y verify-rutas.ts hace `continue` → el archivo no emite NI UN check (falla silenciosa, ni siquiera un verde sospechoso). Next.js honra ese binding como handler: un route.ts es un módulo normal y Next lee sus exports nombrados. Y el proponente se queda corto en realismo: la variante idiomática del ecosistema Next es `export { handler as GET, handler as POST }` (patrón NextAuth), que evade el detector exactamente igual. O sea que la sintaxis evasora no es rebuscada, es la que la gente copia de la documentación de otras librerías.

---

### 8. [ALTA] `verify:rutas` — `../web/app/api/webhooks/stripe/route.ts`

**Mutación que sobrevive a TODA la suite:**

```
export const POST = (req: Request) => webhook("stripe", req);
→
export async function POST(req: Request) {
  // sin verificar la firma HMAC: cualquiera puede mandar un evento de Stripe falso
  const evt = (await req.json()) as { type: string; data: unknown };
  return Response.json(await aplicarEventoStripe(evt));
}
```

**Qué se rompe:** El encabezado del test justifica la exención: 'Los webhooks van por OTRO camino (cuerpo crudo + firma HMAC), así que se excluyen'. Pero la exención se concede por el NOMBRE DE LA CARPETA y lo único que se comprueba es `!/POST\s*=\s*ruta/` — que NO usen ruta(). Nadie verifica que el handler siga delegando en `webhook()`, que es donde vive la firma. La premisa de la exención no está probada.

**Camino de daño (verificado por un escéptico independiente):** POST anonimo a /api/webhooks/stripe. web/middleware.ts:30 hace `if (esApi(req)) return;` — la API no la protege el middleware, la protege el pipeline, y el webhook no pasa por el pipeline a proposito. Sin la delegacion no queda NINGUNA capa: el cuerpo entra directo a procesarStripe, que es la fuente de verdad del plan. Con un `client_reference_id` = id de org (visible para cualquier miembro de esa org) un cliente propio se asciende a Equipo gratis (builds a ~$1.8 cada uno), o un tercero le manda un `customer.subscription.deleted` falso a una org que si paga y le apaga el servicio. Rebajo de critica a alta solo porque explotarlo exige conocer un org_id/customer_id, no porque falte capa: no hay ninguna. El escenario realista no es reescribir esta ruta, es AGREGAR la cuarta (Resend, p.ej.) copiando el patron y olvidando `webhook()` — la suite entera se queda verde.

**Nota del juicio:** Confirmado leyendo el test: core/scripts/verify-rutas.ts:44-53 concede la exencion por el NOMBRE DE LA CARPETA (`/(^|\/)webhooks?(\/|$)/` sobre la ruta relativa) y lo unico que comprueba es `!/POST\s*=\s*ruta/`. Un handler que exporte `export async function POST` y no llame a `webhook()` pasa el check tal cual. Nadie verifica la premisa de la exencion (que el handler delegue en el camino de firma). La firma vive UNICAMENTE en web/lib/automata/wiring.ts:194-210 (`webhook()` -> `recibir({rawBody,headers},{verificador: verificarStripe,...})`), y el archivo real es una sola linea: web/app/api/webhooks/stripe/route.ts:6. verify:webhooks prueba el HMAC dentro de core/, no que la ruta lo invoque: e

---

### 9. [ALTA] `verify:cma` — `src/cma/build.ts`

**Mutación que sobrevive a TODA la suite:**

```
if (c.estado === "en_curso") return { estado: "en_curso" };
→
if (c.estado === "en_curso") return { estado: "satisfecho", codigo: await this.descargarCodigo(sessionId), iteraciones: c.iteraciones };
```

**Qué se rompe:** Un build sin veredicto (needs_revision, o un 'satisfied' bloqueado en requires_action, o sin evals) NO se entrega: cosechar() devuelve 'en_curso' y el drainer lo deja en el outbox para reintentar. Es la MISMA regla que el test prueba en la función pura, pero aplicada en el llamador que sí corre en producción (wiring.ts inyecta CmaBuildClient como cosechador en los tres drainers).

**Camino de daño (verificado por un escéptico independiente):** El comentario de core/src/pipeline/cosecha.ts:107-110 dice que 'en_curso' es el caso NORMAL (el webhook encola en status_idled con la sesion todavia iterando). Con la mutacion, esa primera cosecha se lleva el codigo a medio hacer: descargarCodigo lo baja (el agente escribe automatizacion.py temprano y luego itera), cosecharYConfirmar lo sube, storage.existe() pasa (los bytes SI estan; ese guard vigila otra cosa) y confirmarAjuste marca 'lista'. Ninguna capa posterior lo detiene: el reaper solo barre 'building' (ciclo/servicio.ts:292-296), y la puerta de calidad de la vista corre al EJECUTAR, no al entregar. Consecuencias irreversibles en una sola pasada: se sella `entregada` por trigger (schema.sql:983, once-only), lo que ademas mata el reintento gratis (exige `entregada IS NULL`); app_consumir_ajuste gasta uno de los 3 cambios; y sale el correo 'ya esta lista' con codigo que el grader nunca aprobo. Tambien tapa el caso satisfied+requires_action, que el propio test declara como el guard clave.

**Nota del juicio:** cosechar() (core/src/cma/build.ts:346-353) es codigo de PRODUCCION: web/lib/automata/wiring.ts:486, 505 y 523 inyectan `new CmaBuildClient()` como cosechador en los tres drainers. Y no lo cubre NADA: scripts/verify-cma-clasificar.ts:5 admite de frente que 'el resto del CmaBuildClient toca la red y se prueba con credenciales, aparte' — ese test aparte no existe en package.json (verify:cma apunta solo al clasificador puro), y verify:cosecha:pg / verify:disparo:pg / verify:ajuste:pg pasan DOBLES (`async cosechar(): return {estado:'en_curso'}`), nunca la clase real. La linea 349 es el unico punto donde la decision probada del clasificador se convierte en accion.

---

### 10. [ALTA] `verify:webhooks:handlers:pg` — `src/webhooks/handlers.ts`

**Mutación que sobrevive a TODA la suite:**

```
return plan ? { org, plan } : undefined;
→
return { org, plan: plan ?? "base" };
```

**Qué se rompe:** Un price DESCONOCIDO no toca el plan: nunca se adivina (darle uno que no pago, o quitarle el que pago, son los dos errores caros). Este verify no ejerce NI UNA vez el camino de plan (ignora el valor de retorno de procesarStripe y nunca manda priceId), asi que la garantia que el encargo nombra literalmente no la vigila nadie aqui.

**Camino de daño (verificado por un escéptico independiente):** Un cliente paga Equipo ($1,999) → Stripe entrega customer.subscription.created (con price → plan 'equipo') y checkout.session.completed (sin price). Al procesar el checkout, cambioDePrecio devuelve {org, plan:'base'} y el wiring corre aplicarDowngrade: la org baja a 3 espacios y sus automatizaciones excedentes quedan en solo lectura. Nadie lo detecta: el fallo del webhook ni siquiera se reporta a Stripe (es best-effort) y el único rastro sería el console.error, que aquí ni se emite porque la operación tiene ÉXITO. Cobrar de más y entregar de menos es exactamente el error que el comentario de handlers.ts:112 dice estar evitando.

**Nota del juicio:** Confirmado en las tres puntas. (1) La mutación sobrevive a verify:stripe:pg: su §6 (scripts/verify-stripe-pg.ts:129-131) corre JUSTO DESPUÉS del downgrade de §5, con el plan ya en 'base', así que adivinar 'base' da el mismo resultado; y §1 solo prueba planDePrecio(), que la mutación no toca. (2) El valor devuelto se aplica SIN NINGUNA guarda: web/lib/automata/wiring.ts:216 llama aplicarDowngrade(owner, org, plan) tal cual, y core/src/billing/plan.ts:49 hace `UPDATE subscriptions SET plan=$2` + desactiva el excedente sin comparar con el plan vigente. 'base' es un plan válido, así que ningún CHECK ni trigger lo frena. (3) Lo peor: cambioDePrecio se llama en core/src/webhooks/handlers.ts:148 pa

---

### 11. [ALTA] `verify:rutas` — `../web/app/api/cron/disparo/route.ts`

**Mutación que sobrevive a TODA la suite:**

```
export const POST = (req: Request) => cronDisparo(req);
→
export async function POST(req: Request) {
  // sin comprobar CRON_SECRET: drena la cola de builds a quien la pida
  return Response.json(await drenarDisparosSinAuth());
}
```

**Qué se rompe:** Igual que los webhooks: el comentario dice que los crons son 'OTRO camino sancionado (auth por CRON_SECRET + pool DUEÑO)', pero lo único comprobado es que NO usen ruta(). Que el handler delegue en la función del wiring que sí compara el Bearer CRON_SECRET no se verifica en ningún lado.

**Camino de daño (verificado por un escéptico independiente):** POST anónimo desde internet a /api/cron/disparo → middleware lo deja pasar (línea 31) → cronDisparo sin chequeo → drenarBuilds(getDisparoDeps()) con el pool DUEÑO, sin RLS, operando sobre build_pendiente de TODAS las orgs: corre el planner (Opus, dinero real), abre sesiones de CMA (~$1.8) y devuelve conteos cross-org. El arrendamiento de disparo.ts:43-53 (tomada_en + SKIP LOCKED) evita el doble cobro, pero no evita que un anónimo maneje el pipeline de build de todos los tenants, queme el presupuesto de `intentos` de filas en vuelo (3 intentos → DELETE + incidente + correo 'necesita revisión' al cliente) ni el DoS contra el pool dueño. Lo mismo aplica a /api/cron/reaper, /cosecha y /ajustes: cuatro rutas con el pool sin RLS y cero pruebas de su única puerta.

**Nota del juicio:** Comprobado que la defensa existe y que NADIE la mira. La única auth de los crons es web/lib/automata/wiring.ts:626 (`if (!autorizadoCron(req)) return 401`, con autorizadoCron en wiring.ts:371-377, timingSafeEqual + fail-closed). verify-rutas.ts:47-51 exime a todo lo que caiga bajo /cron/ y solo comprueba que NO use ruta() — jamás toca CRON_SECRET. Un grep por CRON_SECRET/autorizadoCron en core/scripts/ no devuelve nada: ningún verify de los 38 ejerce esa comparación. Y no hay capa detrás: web/middleware.ts:31 dice literalmente `if (esApi(req)) return;` — el middleware NO protege /api, la autenticación vive en el handler. El drainer corre con getPoolOwner() (pool DUEÑO, sin RLS). La mutación 

---

### 12. [ALTA] `verify:lectura:pg` — `src/http/endpoints.ts`

**Mutación que sobrevive a TODA la suite:**

```
if (ultimaVersion === "failed") return "fallo";
→
if (ultimaVersion === "failed") return "generando";
```

**Qué se rompe:** Un primer build que falló y nunca entregó nada se le dice al cliente como 'fallo' — es el estado desde el que la UI ofrece reintentar y el que distingue "se rompió" de "espera un poco".

**Camino de daño (verificado por un escéptico independiente):** Cliente aprueba en /nueva → se cobra el build (~$1.8) → el build revienta (v1 'failed', sin versión ejecutable) → `estadoAuto` devuelve 'generando' en vez de 'fallo' → la tarjeta muestra el esqueleto animado + "Te avisaremos por correo cuando esté lista" y el detalle (web/app/portafolio/[id]/page.tsx:244-249) bloquea con el mismo mensaje. El botón de reintento gratis —que existe y funciona (POST /reintentar)— desaparece para siempre, y el portafolio se queda haciendo polling cada 10 s (portafolio/page.tsx:65) de algo que no va a llegar. Nada lo corrige: el correo de 'fallo' (core/src/ops/notificaciones.ts:68-72) dice "nuestro equipo la revisa… te avisamos", o sea REFUERZA la espera en vez de contradecirla. El cliente pagó, no recibió nada, y el único camino de recuperación autoservicio queda oculto.

**Nota del juicio:** `estadoAuto` (core/src/http/endpoints.ts:233-242) es la ÚNICA fuente del estado que ve el cliente, y el front confía en él ciegamente: web/lib/automata/lectura.ts:118-127 lo copia tal cual y web/app/portafolio/_componentes/tarjeta-automatizacion.tsx:95-108 renderiza el botón "Reintentar gratis" DENTRO de la rama `datos.estado === "fallo"` — el flag `reintentable` (endpoints.ts:299) sigue siendo true pero nunca se pinta si el estado no es 'fallo'. Confirmé que verify-lectura-pg.ts no afirma `estado === "fallo"` en ningún check: §1 prueba lista/generando/congelada, §5 lista, §6 generando, y la única fila realmente fallida (R1, línea 120-129) solo se mira por `reintentable`. La mutación pasa en

---

### 13. [ALTA] `verify:cma` — `src/cma/build.ts`

**Mutación que sobrevive a TODA la suite:**

```
if (!automatizacionPy) throw new Error("El build no produjo automatizacion.py.");
→
if (!automatizacionPy) this.log("build sin automatizacion.py (se entrega igual)");
```

**Qué se rompe:** Un build 'satisfied' que no dejó el script en /mnt/session/outputs NO se entrega: revienta la cosecha (error técnico → reintento) en vez de publicar un artefacto sin código. Es el hermano del guard de bytes de cosecha.ts ('no marcar lista sin artefacto ejecutable'), pero del lado de CMA.

**Camino de daño (verificado por un escéptico independiente):** Grader 'satisfied' sin automatizacion.py → `codigo.automatizacionPy` undefined → cosecha.ts:73 arma el artefacto y JSON.stringify OMITE la clave → put + `existe()` dice que hay bytes (el guard de bytes no mira el contenido) → confirmarAjuste marca 'lista', consume el ajuste y el trigger SELLA `entregada` → sale el correo "ya está lista". Al ejecutar, core/src/run/executor.ts:154 hace `fs.writeFile(scriptPath, undefined)` → TypeError, todas las corridas fallan. Y el cliente queda atrapado: `reintentar` exige `entregada IS NULL`, así que el arreglo entra como AJUSTE, y con `correrRegresion()` devolviendo 'indeterminado' se clasifica como CAMBIO → le gasta 1 de sus 3 ajustes y cobra otra generación. Ninguna otra capa lo detiene: no hay puerta de calidad sobre el artefacto entre la descarga y el 'lista'.

**Nota del juicio:** `descargarCodigo` (core/src/cma/build.ts:274-304) SÍ es código de producción: lo llama `cosechar()` (build.ts:354), que es lo que ejecuta el cron de cosecha vía `drenarCosecha` con `new CmaBuildClient()` (web/lib/automata/wiring.ts:486). El throw de la línea 293 es el único control que convierte "sesión aprobada pero sin script" en error TÉCNICO (cosecha.ts:88-90 lo relanza y la fila se queda en el outbox para reintento). Y el escenario es alcanzable de dos formas realistas: el agente deja el script fuera de /mnt/session/outputs (el SYSTEM de build.ts:75-76 existe precisamente porque el modelo coloca mal los archivos — el incidente del archivo llamado literalmente `--salida` está documentado

---

## Lo que NO se confirmó (y por qué importa dejarlo escrito)

**13 refutados de plano.** El patrón dominante: código sin llamadores de producción. `entitlementsDe`
y `esPlan` (`billing/planes.ts`) no se usan en ningún lado fuera de sus tests; `resolverIncidente` /
`incidentesAbiertos` tampoco — el tablero de ops existe como módulo pero **nadie lo tiene cableado**,
ni ruta, ni cron, ni consola. Eso no es un fallo de la suite: es código sin cliente. Vale anotarlo
como deuda distinta.

**25 inflados, rebajados a media o baja.** Puntos ciegos ciertos, daño menor del anunciado. Los más
instructivos:

- **`conOrg` con `is_local=false`** (el GUC de org sobrevive al COMMIT y la conexión vuelve al pool
  sucia). Se rebajó a alta-inflado porque hoy no existe el segundo eslabón: las únicas queries del
  pool de app fuera de `conOrg` son SECURITY DEFINER que ignoran el GUC. Pero **destruye la red**:
  el patrón del repo es confiar en RLS como filtro (`plan.ts:92` consulta sin `org_id`), así que la
  primera consulta que alguien escriba fuera de `conOrg` devolvería las filas del tenant anterior en
  silencio. Es el hallazgo con más futuro de esta tanda.
- **`afirmarRolSeguro` sin el chequeo de superuser/BYPASSRLS.** `verify:pgstate:pg` abre sus pools
  con `crearPool`, nunca con `crearPoolApp`, así que esa función **no se ejecuta ni una vez** en el
  script que se supone la vigila. El daño lo ataja el segundo guard (rechaza al dueño de tablas),
  que sí cubre los dos roles reales de este proyecto.

**28 ciegas de gravedad media/baja no se sometieron a refutación** — quedan como puntos ciegos
reconocidos, sin veredicto. Reparto: `notificaciones` 5 · `incidentes:pg`, `storage`,
`webhooks:handlers:pg`, `ejecutar:pg`, `cuenta:pg` 3 c/u · resto 1-2.

## Método y herramientas nuevas

- `core/scripts/mutar-lote.ts` — encadena un lote de mutaciones en SERIE (paralelizar da auditoría
  falsa: el archivo de producción se pisa y los `:pg` comparten cola global), escribe resultados en
  cada vuelta, y separa `ERROR` de `SOBREVIVE`. Confundirlos infla la auditoría con humo.
- El cruce de cobertura se calculó con el cierre transitivo de imports de cada script `verify:*`.
  Para `schema.sql`, candidatos = todos los `:pg`.

**Comprobación de integridad:** tras 620 mutaciones, `git diff HEAD` vacío y la suite en verde. El
arnés no dejó residuo.

## Arreglado (2026-07-31, mismo día)

**10 de los 13 cerrados.** Cada uno verificado con su propia mutación: el refuerzo vale cuando la
mutación **MATA**, no cuando el test se ve más completo.

| Verify | Hallazgos cerrados | Cómo |
|---|---|---|
| `verify:rutas` | **6** (5 graves + 1 media) | Reescrito entero |
| `verify:webhooks:handlers:pg` | 2 (incluido el **crítico**) | §1 afirma el CONTENIDO del outbox; §4bis nueva |
| `verify:ejecutar:pg` | 2 | §6 y §7 nuevas |

**`verify:rutas` cambió de principio, no de expresión regular.** Antes reconocía una FORMA
(`export const POST = ruta(...)`) leyendo el texto crudo; ahora RESUELVE cada verbo mutante hasta su
definición —con los comentarios fuera— y exige que llame a una entrada sancionada **importada del
wiring**. Cuatro consecuencias:

- Los comentarios dejaron de contar como código. `// export const POST = ruta(ep);` ya no aprueba
  nada, así que el refactor "comento la línea y escribo el handler debajo" falla en CI.
- `export { POST }` y `export { h as POST }` ahora se ven. Antes el verbo desaparecía del escaneo, y
  lo que no se ve no falla: calla.
- Webhooks y crons se sancionan en POSITIVO. Antes bastaba con NO usar `ruta()`; ahora tienen que
  delegar en el receptor que valida la firma HMAC y en el cron que compara `CRON_SECRET`.
- Un `ruta` casero definido en el propio archivo no sanciona nada.

Y el escáner **se prueba a sí mismo** (§1-3): fixtures sintéticos obligan a que reconocer menos
formas ROMPA el test. Ese silencio era el hallazgo #2. Se conserva el patrón envuelto legítimo
(`const invitar = ruta(ep)` + un POST que lo llama), con su propio check para que arreglar esto no
rompa código correcto — la otra forma de fallar, no más barata.

**El crítico:** `version_id` y `auto_id` son los dos `uuid`, así que cruzarlos inserta igual de bien
y `count(*)` sigue dando 1. El test ahora compara los tres ids contra los reales.

**Los del Run:** §6 desactiva la automatización (`activa=false`, el excedente de un downgrade) y
exige `SinVersionEjecutable` sin cobro; §7 siembra una v2 cuyo artefacto produce **99** en vez de 42
y exige que el resultado traiga 99. Comprobar el `numero` no bastaría: al cliente le llega el
resultado, no el número.

**Suite completa en verde tras los cambios** (38/38), `tsc` limpio.

## Qué queda (3 de 13)

- **CSRF por prefijo** (`verify:adaptador:pg`). Real, pero requiere que alguien cambie `===` por
  `startsWith`, que no pasa por accidente. Mutación registrada arriba.
- **2 de `cma/build.ts`**: entregar una sesión `en_curso` como satisfecha, y entregar un build sin
  `automatizacion.py`. Ambas piden un fixture de sesión de CMA que hoy no existe en la suite.
- Las **28 ciegas de gravedad media/baja**, sin veredicto.

## Deuda que salió de refilón (no es de la suite)

`resolverIncidente` e `incidentesAbiertos` **no tienen un solo llamador**: ni ruta, ni cron, ni
consola. Hay observabilidad escrita que nadie puede mirar. Lo mismo con `entitlementsDe` y `esPlan`.
Cuatro "críticas" de esta auditoría se cayeron por ahí — no porque el test fuera bueno, sino porque
el código no lo usa nadie.

## Nota de método

Los 13 confirmados **estaban reportados, no arreglados**. Reforzar los tests toca 6 archivos:
`verify-rutas.ts` (5 hallazgos, un solo arreglo: que el auditor exija delegación real en vez de
reconocer una forma sintáctica), `verify-cma-clasificar.ts` (2), `verify-ejecutar-pg.ts` (2),
`verify-webhooks-handlers-pg.ts` (2, incluido el crítico), `verify-adaptador-pg.ts` (1) y
`verify-lectura-pg.ts` (1).

Cada mutación de arriba queda como criterio de aceptación: el refuerzo sirve cuando la mutación
**MATA**.
