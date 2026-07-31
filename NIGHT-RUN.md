# Night run: auditar la SUITE, no el producto

Pégale esto tal cual a la sesión nocturna. Es autocontenido.

---

## Objetivo

La suite de `core/` tiene 38 scripts `verify:*` y todos están en verde. La pregunta de esta corrida
NO es "¿pasa el producto?" sino **"¿estos tests detectarían el bug que dicen vigilar?"**

No es paranoia. En este proyecto ya pasó, varias veces y en el camino del dinero:

- Cuatro bugs críticos vivieron bajo 35 verify en verde (ver `CLAUDE.md`).
- `verify:notificaciones` tenía los tipos de correo **hardcodeados**: se agregó `invitacion` y se
  coló sin una sola prueba, con la suite en verde.
- El primer `verify:pasarela:pg` **pasó con el bug del price duplicado presente** (comparaba contra
  `planDePrecio`, cuyo mapa es un objeto literal: con la llave repetida gana el último y responde
  tan campante).
- El `verify` base se rompió al arreglar el Run y nadie lo notó durante un commit entero.
- La prueba del ajuste comparaba JSON completo y fallaba por el orden de llaves de `jsonb`, no por
  el bug que buscaba.

El producto está a punto de cobrar dinero real. Una suite en la que no se puede confiar es **peor
que no tener suite**: produce confianza falsa.

## Método: matar mutantes

Para cada `verify:*`, por cada cosa que dice comprobar:

1. Rompe **el código de producción** (`core/src/**`), no el test.
2. Corre ese verify.
3. Si **falla** → el test hace su trabajo. Sigue.
4. Si **queda en verde** → ese test es ciego ahí. **Es un hallazgo.**

Hay arnés, úsalo (restaura el archivo siempre, incluso con Ctrl-C, y afirma que quedó idéntico):

```bash
cd core
npx tsx scripts/mutar.ts <archivo> <buscar> <reemplazar> <script-verify>
```

Ejemplo real:

```bash
npx tsx scripts/mutar.ts src/salida/csv.ts '/^[=+\-@\t\r]/' '/^[+\-@\t\r]/' verify:csv
# → MATA (el test sí vigila la neutralización del '=')
```

`MATA` = el test sirve. `SOBREVIVE` = hallazgo. Exit 0 cuando mata, 1 cuando sobrevive.

## Por dónde empezar (prioridad por daño si falla)

1. **Dinero**: `verify:cuota:pg`, `verify:plan:pg`, `verify:stripe:pg`, `verify:pasarela:pg`,
   `verify:ciclo:pg`, `verify:ajuste:pg`. Muta topes, comparadores (`>=` ↔ `>`), estados válidos,
   el tipo derivado de la regresión, quién paga y quién no.
2. **Aislamiento entre clientes**: `verify:pg`, `verify:pgstate:pg`, `verify:http`,
   `verify:adaptador:pg`, `verify:lectura:pg`. Muta filtros por org, guardas de membresía, los
   `WHERE` de RLS, el scope de las SECURITY DEFINER.
3. **Entrada hostil**: `verify:entrada`, `verify:entrada:gate`, `verify:csv`, `verify:sandbox`.
4. El resto.

Mutaciones que suelen revelar ceguera: invertir un booleano, cambiar `&&` por `||`, quitar un
`await`, cambiar el orden de dos comprobaciones, devolver el valor por defecto en vez del calculado,
quitar un `WHERE`, cambiar un `throw` por un `return`.

## Qué entregar

`AUDITORIA-SUITE.md` en la raíz, con:

- Tabla: verify → nº de mutaciones probadas → cuántas sobrevivieron.
- Por cada superviviente: qué se rompió, por qué el test no lo vio, y **qué tan grave sería en
  producción** (no todos importan: que no se compruebe el texto de un mensaje de error es benigno;
  que no se compruebe quién paga, no).
- Los tests que **reforzaste**, con el mutante que ahora sí matan.

Refuerza los tests de las categorías 1 y 2. Para el resto, con reportarlo basta — es mejor una lista
honesta que 30 tests escritos a las 4am.

## Reglas duras

- **No toques `core/src/**` ni `web/**` como cambio permanente**, salvo un test que estés
  reforzando. Las mutaciones son temporales y el arnés las revierte.
- **`git status` limpio de mutaciones antes de cada commit.** Si `mutar.ts` alguna vez dice
  `NO SE PUDO RESTAURAR`, para y arregla eso primero.
- **Cero gasto.** No corras builds reales (`/api/cron/disparo`, `/api/cron/ajustes`): cuestan ~$1.8
  cada uno. No hace falta ninguna llave.
- **No toques Neon** (`web/.env` apunta a producción). Todo va contra el Postgres local de pruebas.
- **No hagas push.** Commitea en una rama `auditoria-suite` y déjala ahí.
- Si un verify falla **sin** mutación, no lo "arregles" cambiando el test: entiende por qué. Puede
  ser un bug real del producto — así aparecieron los mejores hallazgos de esta semana.

## Entorno

```bash
cd core && ./scripts/bd-prueba.sh   # levanta/recrea el Postgres de pruebas en 55432 (idempotente)
npm run typecheck
npm run verify:csv                   # humo rápido, sin BD
```

- Los 20 verify con sufijo `:pg` necesitan ese Postgres. El script lo crea desde cero si no está;
  el datadir vive en `~/.automata-pg-prueba` (estable, fuera del repo).
- Para apuntar la suite a **otro** cluster hay que exportar las **tres**: `ADMIN_URL`,
  `DATABASE_URL` y `DATABASE_URL_WEBHOOK`. Con solo dos, un pool se queda en el cluster viejo y el
  test falla mezclando bases — parece bug del producto y no lo es.
- Si editas `core/`, el front no lo ve hasta correr `pnpm install` en `web/` (pnpm **copia**
  `file:../core`). Para esta corrida no debería hacer falta tocar `web/`.
- La suite **vacía `ajuste_pendiente`** al arrancar (hermeticidad): no dejes nada encolado a mano
  esperando sobrevivirla.
