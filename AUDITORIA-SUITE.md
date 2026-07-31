# Auditoría de la suite por MUTACIÓN — en curso

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

## Hallazgo 2 — `verify:cuota:pg` prueba los topes, no que se cobre

Quitando entera la línea que cobra la generación al arrancar un build (`PERFORM app_consumir(…,
'generaciones')` en `cobrar_build`), `verify:cuota:pg` sigue en verde: los builds saldrían **gratis
e ilimitados** y el test de cuota no se entera. Lo caza `verify:ciclo:pg`.

Es el mismo patrón que el hallazgo 1: el test que *posee* el tema (cuota) valida los límites pero no
que el cobro ocurra en el camino real; la red está en otro test, por accidente.

**Gravedad media, no alta**, porque la suite en conjunto sí lo detiene. Pendiente de reforzar
`verify:cuota:pg` con un check de "arrancar un build consume una generación".

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

## Dudas para el dueño

- ¿Vale reforzar `verify:cuota:pg` con el cobro, o basta con que `verify:ciclo:pg` lo cubra? Mi
  criterio: sí vale — el test debe fallar por lo que promete su nombre, no depender de otro.
