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
- `verify:http` sobrevive a las mutaciones de RLS y **no es un hallazgo**: su guarda de membresía
  (capa 6) corta el cross-org antes de que RLS entre en juego. Es lo que ese test debe probar.

## Dudas para el dueño

- ¿Vale reforzar `verify:cuota:pg` con el cobro, o basta con que `verify:ciclo:pg` lo cubra? Mi
  criterio: sí vale — el test debe fallar por lo que promete su nombre, no depender de otro.
