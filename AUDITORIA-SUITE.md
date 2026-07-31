# Auditoría de la suite por MUTACIÓN — TERMINADA (2026-07-31)

**Estado:** ~84 corridas de mutación sobre 24 de los 38 verify. **9 hallazgos, 9 arreglados y
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

## Observación — `verify:plan:pg` detecta el fallo, pero COLGÁNDOSE

Dos mutaciones del downgrade (no desactivar el excedente; conservar las automatizaciones más nuevas
en vez de las más antiguas) **no hacen fallar** a `verify:plan:pg`: lo dejan colgado para siempre.
El test tiene casos de concurrencia con advisory locks, y al romper el downgrade una transacción se
queda esperando a otra que nunca cierra.

No es un punto ciego —el cambio se detecta— pero **en CI es peor que un fallo**: bloquea el pipeline
en vez de reportar, y sin tope se lleva la corrida entera por delante (se llevó dos de esta
auditoría). Vale la pena ponerle un `statement_timeout` a las transacciones de ese test para que
falle rápido y con mensaje.

`mutar.ts` ahora corta a los 180 s y lo reporta como `SE CUELGA`, su propia categoría.

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

1. **`statement_timeout` en `verify:plan:pg`** para que falle rápido en vez de colgarse. Ver la
   observación de arriba. Es lo único con impacto real (en CI bloquea el pipeline).
2. **14 de los 38 verify sin auditar a fondo** — los de menor valor: `incidentes:pg`, `storage`,
   `pgstate:pg`, `adaptador:pg`, `entrada:gate`, `webhooks:handlers:pg`, `ejecutar:pg`, `rutas`,
   `notificaciones`, `cuenta:pg`, `lectura:pg` (parcial), `cma`, y los unit de `ciclo`/`cuota`.
   El arnés queda listo para retomarlos: `npx tsx scripts/mutar.ts [--sql] <archivo> <buscar>
   <reemplazar> <verify>`.
3. **Nada que decidir.** Los 9 hallazgos están cerrados y verificados; no hay preguntas abiertas.

## Cómo revisar esto

```
git diff main..auditoria-suite
```

9 commits, uno por hallazgo, cada uno explicando qué se rompió y por qué el test no lo vio. El
**único** cambio a código de producción en toda la auditoría es de una palabra: exportar
`LIMITES_DEFAULT` (`core/src/run/executor.ts`) para poder afirmar los límites por defecto. Todo lo
demás son tests.
