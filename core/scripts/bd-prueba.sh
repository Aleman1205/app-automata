#!/usr/bin/env bash
# Levanta (o recrea) el Postgres de PRUEBAS en el puerto 55432. Idempotente: si ya responde, no
# hace nada.
#
# Por qué existe: el cluster de pruebas se venía creando a mano dentro del scratchpad de la sesión
# (/private/tmp/claude-501/<id>/…). Ese directorio es POR SESIÓN y macOS limpia /private/tmp, así
# que al retomar en otra sesión —o de madrugada— la BD simplemente no está y los 20 verify con
# sufijo :pg fallan todos a la vez. El síntoma parece un bug del producto y no lo es.
# Aquí el datadir vive en un sitio ESTABLE fuera del repo (no se commitea, no se borra solo).
set -euo pipefail

PUERTO="${AUTOMATA_PGPORT:-55432}"   # override SOLO para probar este propio script
DATOS="${AUTOMATA_PGDATA:-$HOME/.automata-pg-prueba}"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ESQUEMA="$AQUI/../db/schema.sql"

# Los binarios de la fórmula de Homebrew; `postgres` no está en el PATH por defecto con @14.
BIN="$(ls -d /opt/homebrew/Cellar/postgresql@14/*/bin 2>/dev/null | tail -1 || true)"
[ -n "$BIN" ] || BIN="$(ls -d /usr/local/Cellar/postgresql@14/*/bin 2>/dev/null | tail -1 || true)"
if [ -z "$BIN" ]; then echo "✗ No encontré postgresql@14 (brew install postgresql@14)"; exit 1; fi

if "$BIN/pg_isready" -h 127.0.0.1 -p "$PUERTO" >/dev/null 2>&1; then
  echo "✓ Postgres de pruebas ya responde en $PUERTO"
else
  if [ ! -d "$DATOS/base" ]; then
    echo "· Creando cluster en $DATOS…"
    rm -rf "$DATOS"
    "$BIN/initdb" -D "$DATOS" -U postgres --auth=trust >/dev/null
  fi
  echo "· Arrancando en $PUERTO…"
  # -k '' desactiva el socket unix: así solo se llega por TCP a 127.0.0.1, como en los verify.
  "$BIN/pg_ctl" -D "$DATOS" -o "-p $PUERTO -k '' -h 127.0.0.1" -l "$DATOS/servidor.log" start >/dev/null
  for _ in $(seq 1 20); do
    "$BIN/pg_isready" -h 127.0.0.1 -p "$PUERTO" >/dev/null 2>&1 && break
    sleep 0.5
  done
  "$BIN/pg_isready" -h 127.0.0.1 -p "$PUERTO" >/dev/null 2>&1 || { echo "✗ No arrancó; ver $DATOS/servidor.log"; exit 1; }
fi

# El esquema es idempotente (CREATE ... IF NOT EXISTS / OR REPLACE) y crea los roles automata_app y
# automata_webhook. ON_ERROR_STOP=1 SIEMPRE: sin él psql sigue tras un error y deja la BD a medias,
# que es peor que fallar.
echo "· Aplicando esquema…"
# SIN pipe a propósito: con `psql … | grep` el estado de salida es el del GREP, así que un esquema
# que revienta a la mitad se veía como éxito. Pasó de verdad al escribir esto: el cluster nuevo
# quedó sin el rol automata_webhook y el script dijo "listo".
if ! salida="$("$BIN/psql" "postgres://postgres@127.0.0.1:$PUERTO/postgres" -v ON_ERROR_STOP=1 -q -f "$ESQUEMA" 2>&1)"; then
  echo "✗ El esquema falló:"; echo "$salida" | tail -20; exit 1
fi

# No basta con que psql no truene: se AFIRMA lo que los verify necesitan. Un cluster a medias es
# peor que uno ausente, porque los tests fallan por razones que no tienen que ver con el producto.
faltan="$("$BIN/psql" "postgres://postgres@127.0.0.1:$PUERTO/postgres" -tAc \
  "SELECT string_agg(r,',') FROM unnest(ARRAY['automata_app','automata_webhook']) r WHERE r NOT IN (SELECT rolname FROM pg_roles)")"
if [ -n "$faltan" ]; then echo "✗ Faltan roles: $faltan"; exit 1; fi
echo "✓ Listo: postgres://postgres@127.0.0.1:$PUERTO/postgres (roles automata_app + automata_webhook)"
