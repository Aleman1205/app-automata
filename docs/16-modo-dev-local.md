# 16 — Modo dev local: el producto real corriendo sin credenciales

> **Qué es este doc.** El runbook del **modo dev local** (agregado 2026-07-27): correr el
> producto **completo y real** —front consumiendo el backend real (pipeline de 8 capas, RLS,
> cuota, kill-switch, Run que ejecuta código de verdad)— en la máquina, contra un Postgres
> local + storage en disco, **sin una sola credencial ni cuenta externa** (Clerk, Neon,
> Upstash, R2, Anthropic, CMA, Stripe). Es para desarrollar y **demostrar** el producto.
>
> Distíntalo del **prototipo demo** (docs previos): ese usa datos falsos (`web/lib/datos.ts`)
> sin backend. El modo dev local usa el **backend real**; solo sustituye los *puertos externos*.

## ⚠️ Seguridad — esto es un BYPASS de autenticación

El modo dev **doble-gatea** un bypass de auth: solo se enciende si
`NODE_ENV !== 'production'` **Y** `AUTOMATA_DEV_AUTH === '1'` (`web/lib/automata/dev.ts`).
En producción **nunca** se activa, aunque alguien ponga la env (el chequeo de `NODE_ENV`
lo apaga; y `next build` corre con `NODE_ENV=production`).

Lo único que el modo dev sustituye son los **puertos externos**:

| Puerto | Producción | Modo dev |
|---|---|---|
| Sesión (`Sesion`) | Clerk (`auth()`) | usuario fijo `u_dev` (admin), MFA=ahora |
| Rate limit (`RateLimiter`) | Upstash (fail-closed) | permitir siempre |
| Storage (`Storage`) | `R2Storage` | `LocalStorage` en `.dev-storage/` |
| Run executor | `ContainerRunExecutor` (gVisor) | `LocalPythonExecutor` |
| Middleware | `clerkMiddleware` (default-deny) | passthrough |

**TODO lo demás corre igual**: membresía viva, `assertCan` (rol), RLS por org, cuota,
kill-switch, gate de entrada, las 8 capas del pipeline. El modo dev **prueba el backend
real, no lo apaga** — por eso es una demo honesta, no un maqueta.

## Cómo correrlo

Requisitos: un Postgres local con el schema aplicado (en las pruebas de Fase 1 se usó uno
temporal en el puerto **55432**) y `python3` en el PATH (para el Run).

```bash
# 1. Schema aplicado con el rol dueño (crea automata_app / automata_webhook):
psql "postgres://postgres@127.0.0.1:55432/postgres" -f core/db/schema.sql

# 2. Sembrar la org + equipo + automatizaciones (con artefactos EJECUTABLES):
cd core && npm run seed:dev

# 3. web/.env.local (gitignored; NO son secretos — apuntan a lo local):
#   AUTOMATA_DEV_AUTH=1
#   DATABASE_URL=postgres://automata_app@127.0.0.1:55432/postgres
#   APP_ORIGIN=http://localhost:3000
#   NEXT_PUBLIC_AUTOMATA_DEV_ORG=0de00000-0000-0000-0000-0000000de000
#   AUTOMATA_DEV_STORAGE_DIR=<ruta absoluta a>/app-auto/.dev-storage

# 4. Arrancar el front (toma el backend real):
cd web && pnpm dev            # → http://localhost:3000/portafolio
```

`seed:dev` (`core/scripts/seed-dev-pg.ts`) es idempotente: borra la org de dev y la recrea con
3 automatizaciones (`lista` **ejecutable**, `generando`, `congelada` ejecutable), un equipo de
3 (`u_dev` admin + Luis, Carmen operadores) y uso del mes. Para las `lista`/`congelada`
escribe un **artefacto real** (Python que agrega un CSV de ventas → resumen+total+ranking) al
storage local, para que el Run las corra de verdad.

## Qué es real y qué sigue falso

| Pantalla / dato | Estado en modo dev |
|---|---|
| Portafolio (lista de automatizaciones) | **Real** (`GET /automatizaciones`, RLS) |
| Chip "Equipo de N" | **Real** (`GET /miembros`) |
| Cuenta: plan + barras de uso | **Real** (`GET /cuenta`: límites del plan + consumo del mes) |
| Equipo: roster (rol, "tú") | **Real** (`GET /miembros`; el `user_id` se prettifica) |
| Detalle: nombre/estado/ejecuciones | **Real** (`GET /automatizacion?id=`) |
| Detalle: historial de corridas | **Real** (`GET /ejecuciones?id=`; duración/estado reales, archivo/quién van "—") |
| **Ejecutar**: archivo → resultado | **Real** — sube CSV, corre en `LocalPythonExecutor`, muestra el Resultado; el resultado **se persiste** (`ejecuciones.resultado_key` + storage) |
| Descargar resultado | **Real** — baja el JSON del Resultado (client-side) |
| Hacer definitiva (congelar) | **Real** (`POST /congelar`; `app_congelar`, cambio en vuelo → 409) |
| Cuenta: precio, método de pago, historial de pagos | **Falso** — vive en Stripe (no en el backend) |
| Pedir un cambio (ajuste) | **Falso** — dispara un build → necesita CMA/Anthropic |
| Equipo/cuenta: nombre y correo de personas | **Falso** — el perfil vive en Clerk; el backend solo guarda `user_id`+`rol` |

El front cae a los datos falsos de `web/lib/datos.ts` cuando no hay backend (sin
`NEXT_PUBLIC_AUTOMATA_DEV_ORG`), así el prototipo sigue funcionando solo.

## Las piezas (código)

| Pieza | Archivo | Qué hace |
|---|---|---|
| Flag + org/usuario de dev | `web/lib/automata/dev.ts` | `DEV` (doble-gated), `DEV_USER`, `DEV_ORG` |
| Middleware | `web/middleware.ts` | En DEV, passthrough (clerkMiddleware ni se construye → arranca sin llaves) |
| Puertos dev | `web/lib/automata/wiring.ts` | En DEV: sesión fija + rate permitir; el Run usa `LocalStorage`+`LocalPythonExecutor` |
| Endpoint de Run | `web/lib/automata/wiring.ts` `correrAutomatizacion` | Multipart `{automatizacionId, archivo}` → `ejecutarAutomatizacion` → Resultado. Solo DEV; prod → 503 |
| Orquestación del Run | `core/src/pipeline/run.ts` `ejecutarAutomatizacion` | freno → versión ejecutable (RLS) → reserva (cuota+kill) → executor → resolver vista → confirmar |
| Siembra | `core/scripts/seed-dev-pg.ts` | Org + equipo + automatizaciones + artefactos ejecutables |
| Capa de lectura del front | `web/lib/automata/lectura.ts` | `listarAutomatizaciones` / `verCuenta` / `listarEquipo` / `verAutomatizacion` / `ejecutarArchivo` (fetch → mapea a la UI, fallback a datos falsos) |

## El Run local, de punta a punta

```
Cliente (navegador, localhost:3000)
  │  POST /api/orgs/:orgId/ejecutar   (multipart: automatizacionId + archivo CSV)
  ▼
correrAutomatizacion (wiring.ts)  — SOLO en DEV
  · 8 capas (adaptarUpload → autorizar): rate → authn(dev) → método → CSRF → org → membresía → rol "ejecutar"
  · materializa el archivo en un temp
  ▼
ejecutarAutomatizacion (core/src/pipeline/run.ts)
  1. verificar_freno('ejecuciones')            [choke-point temprano del kill-switch]
  2. resolver la versión ejecutable más reciente (RLS: cross-org → SinVersionEjecutable/404)
  3. reserva en `ejecuciones` (trg_kill_run + cobrar_ejecucion cobran la cuota)
  4. LocalPythonExecutor.run(artefacto, inputs)  [Python real; SIN modelo; sin red/secretos]
  5. resolverVista(vista, datos)                 [aterriza @resultado.* → Resultado]
  6. confirmar la ejecución ('ok')
  7. persistir el Resultado en storage + ejecuciones.resultado_key  [best-effort; historial/descarga]
  ▼
Respuesta { resultado, ejecucionId, ms }  →  el front lo pinta con <Resultado>
(El historial se lee luego con GET /ejecuciones; "Descargar" baja ese Resultado.)
```

Probado por curl y por `javascript_tool` (fetch multipart desde el origen de la página, CSRF
real): un CSV `vendedor,monto` devuelve `200` con el total y el ranking correctos. El
orquestador tiene su verify unitario contra Postgres: `verify:ejecutar:pg` (11 checks).

## En producción

El modo dev es **solo** para local. En producción:
- La sesión/rate/storage vuelven a Clerk/Upstash/R2 (sin tocar el bypass).
- El **Run NO corre en un route serverless** de Vercel (`LocalPythonExecutor` ni puede
  `spawn`): va en el **runner aislado** (gVisor/CMA, docs/02, docs/11). Por eso
  `correrAutomatizacion` devuelve **503** fuera de DEV hasta desplegar ese runner. La
  función `ejecutarAutomatizacion` (core) es exactamente lo que ese runner invoca.
- Ver el [checklist de activación](15-motor-implementado.md#8-checklist-para-activar-en-producción).
