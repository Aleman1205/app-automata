# 14 — Controles de seguridad (matriz de casos comunes)

> El mapa único que recorrería un revisor de seguridad (OWASP ASVS / API Top 10):
> qué ataca cada dominio, cómo lo paramos, **en qué capa** vive el control, **en qué
> milestone** se construye y su **estado HOY**. El diseño detallado vive en
> [docs/13](13-auth-y-webhooks.md) (auth/authz/webhooks), [docs/11](11-threat-model.md)
> (threat model) y [docs/04](04-multitenancy.md) (RLS); **este doc los une, cierra
> las derivas y agenda los huecos** que faltaban.
>
> Producido tras una auditoría por-dominio (2026-07-21): 65 casos comunes → 33
> documentados, 25 parciales, 7 ausentes. La conclusión de fondo: **el diseño es
> profesional en los 5 dominios; lo que falta es construcción** — salvo RLS y las
> primitivas de autorización, que ya están **probadas en código** (M2).

## Estado de implementación (2026-07-26)

> **Actualización de fondo.** Cuando se escribió este doc (auditoría 2026-07-21) la
> conclusión era "el diseño es profesional; lo que falta es construcción". **Eso ya
> no aplica.** La Fase 1 construyó el motor real (`core/`, framework-agnóstico;
> `web/` es el cableado a Next 16), con una suite de **28 scripts `verify:*`**
> (`core/package.json:26-58`) que corre verde contra Postgres. Muchas filas marcadas
> abajo 🟡/📝 **ya están construidas y probadas**; las tablas conservan su símbolo
> original y cada sección lleva un bloque **"Actualización (2026-07-26)"** que dice
> qué pasó a implementado y con qué `verify:*` se prueba. Lo que sigue **deferido**
> es *activación de producción* (llaves/infra: credenciales, webhooks en consola
> CMA/Stripe, crons de Vercel, runner gVisor desplegado), **no código**.

Lo construido este ciclo, con evidencia y su prueba:

| Control | Evidencia (archivo:línea) | Prueba |
|---|---|---|
| **Pipeline HTTP de 8 capas** (`withEfecto`/`autorizar`), fail-closed | `core/src/http/pipeline.ts:51` (autorizar), `:106` (withEfecto) | `verify:http`, `verify:adaptador:pg` |
| **Cobertura anti-olvido**: enumerador que falla si un handler con efecto se salta `withEfecto` | `core/scripts/verify-rutas.ts` | `verify:rutas` |
| **Rol no-dueño + guard obligatorio** (rechaza super/BYPASSRLS y DUEÑO) | `core/db/schema.sql:14-20`; `core/src/db/pg.ts:28`, `:41`, `:54-66` | `verify:pg` |
| **RLS FORCE + policy por org en 7 tablas** | `core/db/schema.sql:774-798` | `verify:pg` |
| **Blindaje `pg_temp`** (`SET search_path = public, pg_temp` en todas las funciones + REVOKE TEMPORARY/CREATE) | `core/db/schema.sql:290-303` | `verify:ventana:pg` |
| **REVOKE INSERT/DELETE ON orgs** (anti-reciclador de tenant) + **purgarOrg** owner-only con bitácora sobreviviente | `core/db/schema.sql:314-315`; `core/src/ops/killswitch.ts:102` | `verify:offboarding:pg` |
| **Kill-switch DB-enforced** (guard temprano `verificar_freno` + triggers backstop) + suspensión por-org + bitácora append-only | `core/db/schema.sql:413` (verificar_freno), `:821-833` (triggers); `core/src/ops/killswitch.ts:54` | `verify:killswitch:pg` |
| **Cuota DB-enforced** (`app_consumir` solo-suma; cobro al ARRANCAR el build y al RESERVAR el run; sin oversell/auto-ascenso/reset) | `core/db/schema.sql:375` (app_consumir), `:627` (cobrar_build), `:841` (cobrar_ejecucion) | `verify:cuota:pg`, `verify:plan:pg`, `verify:pgstate:pg` |
| **Circuit breaker de reparaciones** con LATCH persistente (`en_revision`), ventana rodante 30d, ledger no reescribible | `core/db/schema.sql:627-679`; `core/src/ciclo/servicio.ts:274` (limpiarRevision) | `verify:reparaciones:pg` |
| **Ventana de 30 días** anclada a la ENTREGA (sellada una vez) + entrega garantizada anti-brick | `core/db/schema.sql:440` (en_ventana_gratis), `:684` (marcar_entrega); `core/src/ciclo/servicio.ts:190` (confirmarAjuste) | `verify:ventana:pg`, `verify:ciclo:pg` |
| **Reaper de builds colgados** + `fallarAjuste` cableado al webhook de fallo de CMA (cierra el brick por versión huérfana) | `core/src/ciclo/servicio.ts:286` (reaper), `:139` (auto-sana); `core/src/webhooks/handlers.ts:66` | `verify:ciclo:pg`, `verify:webhooks:handlers:pg` |
| **Incidentes durables** (tabla append-only + SD; `emitirEnTx` con SAVEPOINT anti re-brick) — reemplazan los `console.error` sin lector | `core/db/schema.sql:236` (tabla), `:542` (app_registrar_incidente); `core/src/ops/incidentes.ts:36`, `:50` | `verify:incidentes:pg` |
| **Cosecha** (outbox `cosecha_pendiente` + guard de bytes con `existe()` antes de marcar 'lista') | `core/db/schema.sql:256`; `core/src/pipeline/cosecha.ts:38`, `:65`; `core/src/storage/r2.ts:98` | `verify:cosecha:pg`, `verify:storage` |
| **Disparo de build** (outbox `build_pendiente` + SD `app_solicitar_build` que fija la org; drainer fuera del request) | `core/db/schema.sql:269`, `:569`; `core/src/pipeline/disparo.ts:31` | `verify:disparo:pg` |
| **Firma de webhooks** (HMAC sobre cuerpo CRUDO: standard-webhooks + Stripe, `timingSafeEqual`, ventana ±5 min) + dedupe atómico + guard monótono anti out-of-order de Stripe | `core/src/webhooks/firma.ts:38`; `core/src/webhooks/receptor.ts`; `core/src/webhooks/handlers.ts`; `core/db/schema.sql:282` (webhook_events) | `verify:webhooks`, `verify:webhooks:handlers:pg` |
| **Gate de insumos CABLEADO** al build/run/upload (magic-bytes/spoofing, XXE, zip-bomb, pixel-flood, sobre de lote) | `core/src/entrada/validador.ts:54`, `:58` (magic bytes); `core/src/entrada/puente.ts:62`, `:69`, `:77` | `verify:entrada`, `verify:entrada:gate` |
| **Sandbox del Run** — Fase 0 endurecido (env allowlist anti-fuga de secretos, `ulimit -t/-f`, kill de grupo, lectura acotada) + Fase 2 jaula gVisor cableada | `core/src/run/executor.ts:121`, `:61`, `:87`, `:97`, `:109`; `core/src/run/container-executor.ts:64`, `:87-102` | `verify:sandbox` |

Sigue como **plan/deferido** (activación, no código): el corte de gasto por build de $10
con `task_budget` acumulado (🟡), el push/alerta a ops al enganchar el latch (📝), el
semáforo de builds concurrentes por org (📝), el mini-spike y gating de OCR (🟡 M5), las
cabeceras de seguridad CSP/HSTS explícitas (📝) y el test de inyección de prompt del
intake (🟡). Ver detalle en cada sección.

## Leyenda de estado

| | Significado |
|---|---|
| ✅ | **Construido y probado** en `core/` con test que corre (SQL o Node). |
| 🟡 | **Diseñado, sin construir.** Aterriza en el milestone indicado (depende de la capa HTTP, que aún no existe). |
| 📝 | **Hueco que abrió esta auditoría.** Se documenta aquí y se agenda en [plan-fase-1](plan-fase-1.md). |

## Principio: dónde vive cada control (el pipeline de una request)

Toda request **con efecto** pasa, en orden, por estas capas. Es el §3 de docs/13
**ampliado** con las dos capas que faltaban como escalón explícito (rate-limit y
validación de esquema):

```
0. Rate limit / WAF        → ¿demasiadas peticiones? (por IP y por org)      → 429   [📝 nuevo]
1. Clerk (authn)           → ¿quién es? JWT verificado en el servidor         → 401
2. CSRF / Origin           → ¿la mutación viene de nuestro origen?            → 403   [📝 nuevo]
3. Contexto org            → ¿en qué org actúa? (de la sesión, NUNCA del cliente)
4. assertCan (authz)       → ¿su rol permite esta acción aquí? membresía VIVA → 403
5. step-up MFA             → ¿acción peligrosa? re-verificar factor            → challenge
6. Validación (Zod)        → ¿body/query/params válidos, con allowlist?        → 400   [📝 nuevo]
7. Query con rol no-dueño  → RLS filtra por org_id (fail-closed sin contexto)
```

Las capas **4 (rol)** y **7 (aislamiento)** son distintas y **ambas** hacen falta;
un bug en una no debe abrir la otra. La regla de oro: **el webhook entrante se salta
1–5 pero se autentica por firma HMAC** (§4 de docs/13) y deriva su org del **recurso
firmado**, no del payload (evita el *confused deputy*).

> **Construido: las 8 capas viven en `core/src/http` (`withEfecto`), probadas
> end-to-end** (`verify:http` 24/24 contra Postgres) con puertos fake para Clerk/rate.
> El orden real pone authz ANTES de step-up/validación (un no-miembro recibe 403
> uniforme, sin enumerar esquemas). Fail-closed verificado tras su revisión adversarial:
> CSRF niega si falta el Origin, step-up rechaza un MFA con timestamp futuro, `invitar`
> exige step-up, e **IDOR cross-org por HTTP → 403**. Falta el cableado a Next + servicios
> vivos: contrato en [`core/src/http/adaptador-next.md`](../core/src/http/adaptador-next.md).

---

## 1. Autenticación — veredicto: huecos menores

Diseño sólido (Clerk: sesión corta auto-refrescada, MFA obligatoria admin/facturación,
step-up, membresía viva). **Casi nada construido**: Clerk aún no es dependencia, no hay
`middleware.ts` ni verificación server-side del JWT. Varios vectores canónicos estaban
**sin declarar** (se delegaban a Clerk en silencio).

> **Actualización (2026-07-26):** ya NO es "casi nada". La **capa de autenticación** del
> pipeline está construida y probada (capa 1: `core/src/http/pipeline.ts:63-65`,
> `verify:http`), el **puerto de sesión de Clerk** está cableado con verificación
> server-side (issuer + JWKS) en `web/lib/automata/wiring.ts:39`, y **`middleware.ts`
> existe** con default-deny anti forced-browsing (`web/middleware.ts:21`). Lo que sigue
> deferido es la *activación* con llaves de Clerk (session token con recencia de MFA), no
> el código.

| Caso común (OWASP) | Crit | Defensa / postura | Capa | Milestone | Estado |
|---|:--:|---|:--:|:--:|:--:|
| **Verificación server-side del JWT de Clerk** — sin esto assertCan y RLS son evadibles (atacante pone cualquier user_id/org_id) | alta | `clerkMiddleware` + `auth()` por request; issuer + JWKS, no secreto compartido | 1 | M2 | 🟡 |
| **Firma de webhooks entrantes** (CMA/Stripe) | alta | cuerpo crudo → `webhooks.unwrap` → ventana ±5 min → dedupe por `event.id` | 1 | M0 (CMA) / M3 (Stripe) | 🟡 |
| **Step-up MFA** (facturación, borrar org, quitar gente, exportar código) | alta | `necesitaStepUp` **ya en código**; falta el challenge real de Clerk + recencia del factor | 5 | M2 | 🟡 |
| **Password reset seguro** (MFA en el reset, anti-ATO) | alta | flujo de Clerk **con MFA activado explícitamente** (no solo email link) | 1 | M2 + checklist | 🟡 |
| **Membresía viva / expulsión** (autoriza contra la fila, no contra claim) | alta | `leerMembresia` lee `memberships` por request bajo RLS; fail-duro si >1 fila | 4 | **M2** | ✅ |
| Duración / rotación / timeout de sesión (~60 min, 24 h inactividad, 7 d máx) | media | config de Clerk (el timeout de 24 h **no** es default) | 1 | M2 | 🟡 |
| Revocación remota de sesiones (incidente) | media | `sessions.delete()` de Clerk; **falta el procedimiento exacto** en el runbook | — | M4 (runbook §11) | 🟡 |
| **Cookie httpOnly/Secure/SameSite + prohibir token en URL** (hijack por URL/referer) | media | default de Clerk; **declararlo** y prohibir el token en query string | 1 | M2 + checklist | 📝 |
| **CSRF de la sesión** (mutaciones con cookie) | media | `SameSite=Lax` + verificar `Origin`/`Referer` en toda mutación; webhook exento por HMAC | 2 | M2 | 📝 |
| **Session fixation** | media | Clerk rota el id de sesión al login — **declararlo como asunción verificada** | 1 | checklist | 📝 |
| **Brute-force / credential stuffing** | media | bot-protection + rate-limit nativos de Clerk **activados y verificados** | 0/1 | M2 + checklist | 📝 |
| **OAuth/social login + JWKS** | media | **decisión de alcance**: ¿login social (Google) en MVP? Si sí, verificar vía JWKS con rotación | 1 | M2 (decisión) | 📝 |
| **Gestión de secretos de auth** (signing keys, DB del rol app) | media | inventario + rotación; **el repo es público** → nada de secretos en git | — | M2/M3 | 📝 |

> **Actualización (2026-07-26) — filas ya implementadas (código):**
> - **Firma de webhooks entrantes** → ✅ `verify:webhooks` / `verify:webhooks:handlers:pg`
>   (`core/src/webhooks/firma.ts:38`, receptor+handlers): HMAC sobre cuerpo crudo, ±5 min,
>   dedupe atómico (`core/db/schema.sql:282`).
> - **Step-up MFA** → la *lógica de enforcement* está construida y probada
>   (`core/src/http/pipeline.ts:90-93`, doble cota anti timestamp futuro, `verify:http`); el
>   challenge real de Clerk + recencia del factor difiere a las llaves.
> - **Membresía viva / expulsión** ya era ✅ y sigue: `core/src/http/pipeline.ts:86`.
> - **Verificación server-side del JWT** → código cableado (`web/lib/automata/wiring.ts:39`);
>   activación difiere a llaves de Clerk.
> Duración/rotación de sesión, password reset con MFA, cookie flags, brute-force y OAuth
> siguen dependiendo de *configurar* Clerk (checklist), no de código.

---

## 2. Autorización — veredicto: huecos menores

Las **primitivas están probadas**: `assertCan` (matriz de rol + cross-org) y
`leerMembresia` tienen test unitario (`verify-auth.ts`) e integración real contra
Postgres (`verify-pg.ts`). El hueco: **nada está cableado** — los únicos importadores
son los scripts `verify-*`. Faltan los controles *estructurales* de OWASP API que
evitan el olvido.

> **Actualización (2026-07-26):** ya está cableado. `withEfecto`
> (`core/src/http/pipeline.ts:106`) llama SIEMPRE a `leerMembresia`+`assertCan` dentro de
> `conOrg` (`:83-96`), y `ruta()` es el único camino sancionado. El control estructural
> anti-olvido existe: un **enumerador de rutas** (`core/scripts/verify-rutas.ts`,
> `verify:rutas`) falla si un handler con efecto se salta `withEfecto`.

| Caso común (OWASP API) | Crit | Defensa / postura | Capa | Milestone | Estado |
|---|:--:|---|:--:|:--:|:--:|
| **BOLA / IDOR** (leer objeto de otra org por id en URL) | alta | RLS por `org_id` (**probado**) + cross-org en `assertCan`; falta el test de integración `A lee objeto de B por API → 404/403` | 4/7 | M2 | 🟡 |
| **BFLA** (operador invoca acción de admin) | alta | matriz de rol **probada**; falta garantizar que **cada** endpoint la llame | 4 | M2 | 🟡 |
| **BOPLA / mass-assignment** (inyectar `rol`/`org_id`/`plan` en el body) | alta | rol viene de DB (no del body) + `WITH CHECK`; **falta allowlist de campos de escritura por DTO** | 6 | M2 | 📝 |
| **Cobertura uniforme** (garantía anti-olvido) | alta | `withAuthz` obligatorio que envuelva **toda** route handler + test que enumere el árbol de rutas y falle si alguna no autoriza | 4 | M2 | 📝 |
| **Forced browsing** (ruta olvidada sin gate) | alta | middleware **default-deny** con allowlist de rutas públicas (patrón Next 16 + Clerk) | 1 | M2 | 🟡 |
| Enforcement server-side en cada endpoint con efecto (no en UI) | alta | el `withAuthz` de arriba; ocultar un botón **no** es seguridad | 4 | M2 | 🟡 |
| **Confused deputy** (jobs/webhooks sin contexto de org) | media | todo job deriva la org del **recurso firmado** y corre en `conOrg(esaOrg)` | 3 | M0/M3 | 🟡 |
| Deny-by-default / fail-closed | alta | sin membresía → 403 (**probado**). Endurecer: `accion` fuera de tipo → 403 controlado, no `TypeError` 500 | 4 | M2 | ✅ |
| Rol contra membresía VIVA (no claim horneado) | alta | `leerMembresia` dentro de `conOrg(org)` (**probado**, incl. revocación en caliente) | 4 | **M2** | ✅ |
| Matriz de rol completa vs docs/13 §2 | media | código = doc (`admin` todo / `operador` ejecuta+descarga; +`exportar_codigo`) | 4 | **M2** | ✅ |

> **Actualización (2026-07-26) — filas ya implementadas (código):**
> - **BOLA / IDOR** → ✅ `verify:http` incluye "IDOR cross-org por HTTP → 403"; RLS +
>   cross-org en `assertCan` (`core/src/http/pipeline.ts:86-87`).
> - **BFLA** y **Enforcement server-side en cada endpoint** → ✅: `withEfecto`
>   (`core/src/http/pipeline.ts:106`) obliga a `assertCan` en todo handler con efecto.
> - **Cobertura uniforme (anti-olvido)** → ✅ `verify:rutas` (`core/scripts/verify-rutas.ts`).
> - **Forced browsing** → ✅ middleware default-deny (`web/middleware.ts:21`).
> - **Confused deputy** → ✅: los jobs derivan la org del **recurso firmado** vía SDs
>   cross-org (`core/db/schema.sql:501` `resolver_sesion_cma`, `:506` `resolver_org_stripe`),
>   nunca del payload; probado en `verify:webhooks:handlers:pg`.
> Sigue 📝: **BOPLA/mass-assignment** con allowlist de campos de escritura por DTO (el
> esquema de frontera existe —`core/src/http/pipeline.ts:110`— pero la allowlist por-DTO no
> está formalizada).

---

## 3. Rate limiting / abuso de recursos — veredicto: **huecos serios**

Bien pensado en papel (docs/11 §8, docs/06 §3-4, docs/10 §8, docs/03 §5). Es el dominio
donde el **dinero** se protege: el build cuesta **~$1.8** y el Run **<1¢** (corregido;
ver §8 de docs/11). El genérico por IP/org sigue siendo el más flaco: solo vive en prosa.

> **Actualización M3 (2026-07-21): el motor de cuotas está construido y probado**
> (`core/src/billing/`, `verify:cuota:pg` 24/24). Corrección clave de su revisión
> adversarial: el enforcement **vive en la BD, no en el código de la app** — con solo
> RLS, el rol `automata_app` podía `UPDATE subscriptions SET plan='equipo'`
> (auto-ascenso) o `UPDATE uso_periodo SET ejecuciones=0` (resetear el tope). Ahora los
> límites viven en la tabla `planes`, el STOCK lo imponen **triggers con advisory lock
> por-org** (TOCTOU-safe) y el FLUJO una función `app_consumir` **SECURITY DEFINER que
> solo suma**; el rol de app pierde `UPDATE/DELETE` sobre billing. Probado: sin
> oversell, sin auto-ascenso, sin reset, cancelado no consume. **Falta el cableado HTTP
> + Stripe** (difiere al wrapping de Next).

| Caso común | Crit | Defensa / postura | Capa | Milestone | Estado |
|---|:--:|---|:--:|:--:|:--:|
| **Rate-limit por IP/usuario/org en endpoints** (API4) | alta | **elegir store** (Upstash Ratelimit / Vercel WAF) y cablear en middleware **antes** de exponer cualquier endpoint | 0 | M2 | 📝 |
| **Wallet-DoS por disparo de builds** (~$1.8 c/u) | alta | **cobro al ARRANCAR** el build: trigger sobre el INSERT de `versiones` → `app_consumir(...,'generaciones')`. Único choke-point que cruzan v1, ajustes y rutas futuras | 7 | **ventana-30d** | ✅ |
| **«El reciclador»** (docs/06 §3): borrar y recrear resetea contador, ventana y espacio | alta | `REVOKE DELETE` sobre `automatizaciones`/`versiones`/`ejecuciones` (archivar es `activa=false`) + el v1 ya cobra generación. Medido: de 40 builds con contador en 0, a corte en el 7º | 7 | **ventana-30d** | ✅ |
| **«El que falla mucho»** (docs/06 §3): iniciar+fallar en bucle | alta | al cobrar al arrancar, un build fallido **sí** consume generación (corrige docs/06 §4) | 7 | **ventana-30d** | ✅ |
| Org **morosa/cancelada** sigue arrancando builds | alta | `app_consumir` exige `subscription.estado='activa'`; al cobrarse en el INSERT, el corte llega **antes** de gastar | 7 | **ventana-30d** | ✅ |
| **Reparaciones sin tope** (build real ~$1.8; el cliente influye en la regresión) | media | **circuit breaker con LATCH**: ventana rodante 30d (cap en `planes.reparaciones`), al tope engancha `automatizaciones.en_revision` (persiste entre meses, solo ops rearma). Cuenta fallidas. Morosa/cancelada no dispara | 7 | **reparaciones** | ✅ |
| **Ledger `versiones` reescribible** (reset del breaker via `UPDATE tipo`/backdate `creada`) | alta | `REVOKE UPDATE ON versiones` + `GRANT UPDATE (estado)`; `creada` normalizada a `now()` en el trigger (BEFORE INSERT). Verificado en vivo: 42501 / no evade la ventana | 7 | **reparaciones** | ✅ |
| **Push/alerta a ops del "en revisión"** (hoy solo pull) | media | cablear notificación al enganchar el latch, antes de que la UI prometa "un humano revisa" | 0 | — | 📝 |
| **Brick por versión `building` huérfana** (build que nunca confirma/falla → `iniciarAjuste` lanza `AjusteEnCurso` para siempre, incluidas reparaciones) | media | cablear **`fallarAjuste` al webhook de fallo de CMA** + reaper que marque `building` añejas → `failed`. Hoy inalcanzable (sin webhooks); obligatorio al cablear | 3 | **wiring** | 📝 |
| **Reconciliación de entregas sin contar** (`confirmarAjuste` entrega y loguea si el conteo no procede) | baja | asiento durable (outbox/tabla de incidentes) en vez de `console.error`; reconciliar `ajustes_usados` al descongelar una automatización con entregas no contadas | 7 | **wiring** | 📝 |
| **Corte de gasto por build $10** + presupuesto acumulado entre reintentos | alta | `task_budget` en la sesión CMA + contador USD acumulado que **corte** | 7 | M3 | 🟡 |
| **Tope de ejecuciones del Run que CORTE** (no solo alarme) | alta | trigger `cobrar_ejecucion` BEFORE INSERT ON ejecuciones → `app_consumir('ejecuciones')` (DB-enforced, simétrico a builds). Cobra al reservar, exige subscription activa | 7 | **pgstate** | ✅ |
| **Cuota por plan / entitlements** (espacios + generaciones) | alta | tabla `subscriptions` + helper `assertCuota` paralelo a `assertCan` | 4 | M3 | 🟡 |
| **Reserva de cuota con lock** (TOCTOU: N aprobaciones concurrentes) | alta | aprobación atómica (crear automation + reservar espacio + outbox) en una tx | 7 | M3 | 🟡 |
| **Límite de tamaño/número de archivos** (DoS por subida masiva / sobre de lote) | alta | worker de validación aislado; ratio agregado + timeout de lote, no solo por-archivo | 6 | M4 | 🟡 |
| **Límites de recursos del Run** (memoria/CPU/fork-bomb) | alta | cgroups/sandbox del runner real; el M0 ejecuta sin ellos (aislado, sin usuarios) | 7 | M4/runner | 🟡 |
| Brute-force de login (intentos sin límite) | media | límites nativos de Clerk **configurados y verificados** (no asumidos) | 0/1 | M2 + checklist | 🟡 |
| **Builds concurrentes por org** | media | semáforo por org al despachar el job (acota gasto; palanca de venta) | 0 | M3 | 📝 |
| Abuso del intake (entrevistas en bucle) | media | tope por-turno **ya existe**; falta 10 intakes/org/día + presupuesto por intake | 0 | M3 | 🟡 |
| **Kill-switch global** (congelar builds+ejecuciones en incidente) | media | flag global que corta; **probarlo en staging** (checklist §10) | — | M4 | 📝 |
| Retry storm / webhooks duplicados / replay | media | idempotencia + firma + reconciliación cron | 1 | M0/M3 | 🟡 |
| Sondeo del clasificador (`no_procede` repetido) | baja | contador/alerta por org; decidir cuáles pasan de alarma a **corte** | 0 | M3 | 📝 |
| Gating de costo del rung de OCR (único formato que cuesta) | media | gatear por plan + contar egress en la cuota | 6 | M5 (tras mini-spike) | 🟡 |

> **Actualización (2026-07-26) — filas ya implementadas (código):**
> - **Rate-limit por IP/usuario/org** → la *capa 0 del pipeline* está construida
>   (`core/src/http/pipeline.ts:60-61`, `verify:http`) y el store real (Upstash, fail-closed)
>   cableado en `web/lib/automata/wiring.ts:53`. Ya no "solo vive en prosa"; falta afinar
>   cubetas por-org y el WAF.
> - **Brick por versión `building` huérfana** → ✅ cerrado: `fallarAjuste` cableado al webhook
>   de fallo de CMA (`core/src/webhooks/handlers.ts:66`) + reaper
>   (`core/src/ciclo/servicio.ts:286`) + auto-sana en `iniciarAjuste` (`:139`).
>   `verify:ciclo:pg`, `verify:webhooks:handlers:pg`.
> - **Reconciliación de entregas sin contar** → ✅ asiento durable (no `console.error`):
>   `emitirEnTx` registra `entrega_sin_ajuste`/`pago_no_entregado`
>   (`core/src/ciclo/servicio.ts:202`, `:229`; `core/src/ops/incidentes.ts:50`).
>   `verify:incidentes:pg`.
> - **Límite de tamaño/número de archivos (sobre de lote)** → ✅ gate cableado
>   (`core/src/entrada/puente.ts:77` `gatearInputs`, `validarLote`). `verify:entrada`.
> - **Límites de recursos del Run** → ✅ Fase 0 (`ulimit`/kill de grupo/lectura acotada,
>   `core/src/run/executor.ts`) + jaula gVisor Fase 2 (`core/src/run/container-executor.ts`).
>   `verify:sandbox`.
> - **Kill-switch global** → ✅ DB-enforced (dos capas): `verificar_freno`
>   (`core/db/schema.sql:413`) + triggers (`:821-833`); palancas de ops con bitácora
>   (`core/src/ops/killswitch.ts`). `verify:killswitch:pg`.
> - **Retry storm / webhooks duplicados / replay** → ✅ dedupe atómico
>   (`core/db/schema.sql:282`) + firma + guard monótono de Stripe. `verify:webhooks`.
> Siguen deferidos (activación/no-código): corte de gasto por build $10 (🟡), push a ops al
> latch (📝), semáforo de builds concurrentes por org (📝), gating de OCR (🟡 M5).

---

## 4. Row-level security (Postgres) — veredicto: huecos menores (el más maduro)

**El único dominio probado en código por dos caminos** (`test-aislamiento.sql` 10/10
como `automata_app`; `verify-pg.ts` por el camino real Node→pg→RLS). Los huecos son
**residuales de despliegue**, no de diseño.

| Caso común | Crit | Defensa / postura | Capa | Milestone | Estado |
|---|:--:|---|:--:|:--:|:--:|
| FORCE RLS en toda tabla con `org_id` | alta | `FORCE ROW LEVEL SECURITY` + policy por org | 7 | **M2** | ✅ |
| `WITH CHECK` en escrituras (no escribir/re-etiquetar hacia otra org) | alta | policy con `WITH CHECK (org_id = app_current_org())` | 7 | **M2** | ✅ |
| Fail-closed sin contexto (sin `app.current_org` → 0 filas) | alta | `app_current_org()` con `NULLIF(...,'')::uuid` | 7 | **M2** | ✅ |
| **Integridad del `org_id` denormalizado** (FK compuesta anti-enlace cross-org) | alta | `UNIQUE(id,org_id)` + `FK (child_id,org_id)→(id,org_id)` | 7 | **M2** | ✅ |
| Rol de app **no-dueño NOSUPERUSER NOBYPASSRLS** (hueco "RLS inerte") | alta | crear `automata_app` en Neon, `DATABASE_URL` apunta a él, migraciones como dueño aparte | 7 | M2 (wiring) | 🟡 |
| **Guard de arranque `afirmarRolSeguro`** (rechaza super/BYPASSRLS) | alta | **ya existe la función**; hacerla **obligatoria y fatal** en el bootstrap | 7 | M2 (wiring) | 🟡 |
| **Pooling de Neon** (transaction-mode/PgBouncer) vs `SET LOCAL ROLE`/`set_config local` | alta | usar el pooler en modo transacción (o conexión directa) y **probar aislamiento contra la URL del pooler**, no solo local | 7 | M2 | 📝 |
| **Policies en TODAS las tablas + defensa anti tabla-futura** | alta | test de regresión que recorra `pg_class` y **falle** si una tabla con `org_id` no tiene `relforcerowsecurity` | 7 | M2/M4 | 📝 |
| Separación rol de migración (dueño) vs rol de app | media | cubierto por el mismo wiring del rol no-dueño | 7 | M2 | 🟡 |
| Inyección/tampering de `app.current_org` | media | parametrizado + cast; el `orgId` lo pone el **servidor** desde la membresía, nunca un header | 3/7 | M2 | ✅ |
| Cobertura de tests (SELECT/INSERT/UPDATE/DELETE/re-etiquetado) | media | 10/10 local; **falta correrlos en CI contra Neon** | — | M2 | 🟡 |
| **Hijack de `SECURITY DEFINER` vía `pg_temp`** (era "baja/opcional" — **se demostró explotable**) | **alta** | `SET search_path = public, pg_temp` (pg_temp **nombrado al final**) en las 11 funciones + `REVOKE TEMPORARY`/`CREATE` al rol de app | 7 | **ventana-30d** | ✅ |

> ### ⚠️ El ataque `pg_temp` (2026-07-24): por qué `SET search_path = public` NO basta
>
> Se dio por bueno durante cuatro milestones y **rompía el enforcement de todos**.
> Postgres omite `pg_temp` del `search_path` implícito **solo para funciones y
> operadores**; para **relaciones** lo sigue buscando, y **primero**. Así que un
> `CREATE TEMP TABLE automatizaciones (...)` hace que una función `SECURITY DEFINER`
> —que corre como el dueño— lea la tabla **falsa** del atacante.
>
> Verificado en vivo con el rol de aplicación: `app_consumir_ajuste` devolvió
> `ready/0/gratis` sobre una automatización realmente `frozen` con 3 ajustes usados;
> `verificar_freno` dejó pasar builds con el **kill-switch encendido**; y una tabla
> `planes` falsa con límites de 99999 saltó el tope de cuota. Es decir: ajustes
> infinitos, cuota infinita y freno de incidente inerte. Basta una inyección SQL que
> logre ejecutar un `CREATE TEMP TABLE` — y como el pool **reutiliza conexiones**, la
> tabla temporal sobrevive a la request y contamina las siguientes del mismo backend.
>
> **Regla, sin excepciones:** toda función —`SECURITY DEFINER` *o* `INVOKER`, incluidas
> las de trigger— lleva `SET search_path = public, pg_temp`, con `pg_temp` **nombrado
> explícitamente al final** para que pierda la prioridad. Doble defensa: al rol de app
> se le revocan `TEMPORARY` (no crea tablas temporales) y `CREATE ON SCHEMA public`.
> Ambas capas se prueban por separado en `verify-ventana-pg.ts`.

> **Actualización (2026-07-26) — filas ya implementadas (código):**
> - **Guard de arranque `afirmarRolSeguro`** → ✅ ya es **obligatorio**: `crearPoolApp` lo llama
>   al construir el pool (`core/src/db/pg.ts:28`) y además rechaza al rol **DUEÑO** de tablas,
>   no solo super/BYPASSRLS (`:54-66`). `verify:pg`.
> - **Rol de app no-dueño** y **separación rol de migración vs app** → ✅ en código: el schema
>   crea `automata_app` y `automata_webhook` NOSUPERUSER NOBYPASSRLS
>   (`core/db/schema.sql:14-20`, `:514-520`) y el pool de `web` conecta como no-dueño
>   (`web/lib/automata/wiring.ts:71`). Que `DATABASE_URL` apunte al rol correcto sigue siendo
>   paso de despliegue.
> - Nuevo control de este ciclo, no en la tabla original: **REVOKE INSERT/DELETE ON orgs**
>   (`core/db/schema.sql:314-315`) cierra el que el rol de app se auto-cree/borre un tenant y
>   arrastre el ledger por CASCADE; la baja de tenant es owner-only (`purgarOrg`,
>   `core/src/ops/killswitch.ts:102`). `verify:offboarding:pg`.
> Siguen 📝/🟡 (despliegue, no código): probar aislamiento contra la **URL del pooler** de
> Neon, el test que recorra `pg_class` para cazar una tabla-futura sin FORCE RLS, y correr los
> tests en CI contra Neon.

---

## 5. Validación server-side — veredicto: huecos menores

La validación **de la capa de modelo** (intake + planner) está **construida y es
determinista**: `validarSpec` (topes de longitud/reglas), `sanitizar` (strip `<>`),
puerta de coherencia con reintentos, `resolverVista` como quality gate. Las queries
son **parametrizadas**. La validación **de frontera HTTP** (Zod en cada endpoint) sigue
sin construir (no hay capa HTTP). Zod es hoy solo dep transitiva del SDK.

> **Actualización (2026-07-26):** la capa de frontera HTTP **ya existe** (capa 4 del
> pipeline): `withEfecto` corre `ep.esquema.analizar(cuerpo)` y devuelve **400** ante entrada
> inválida, DENTRO de `conOrg` (`core/src/http/pipeline.ts:110-111`). Es una abstracción
> `Esquema` propia (dependency-free), no literalmente Zod; el efecto —"todo input pasa por un
> parser en la frontera o se rechaza"— es el mismo. Lo que falta formalizar es la allowlist de
> campos de escritura por-DTO (ver §2, BOPLA).

> **Actualización M4 (2026-07-21): el gate de validación de INSUMOS está construido y
> probado** (`core/src/entrada/`, `verify:entrada` 34/34). Dependency-free; nunca
> infla/decodifica el input hostil salvo con tope duro. Corrección clave de su revisión
> adversarial: la ZIP-bomb **no** se juzga por los tamaños DECLARADOS (que el atacante
> controla) sino **inflando de verdad con `node:zlib` + `maxOutputLength`**; y el **XXE
> dentro de un XLSX** (que el gate de solo-cabeceras dejaba pasar) ahora se escanea tras
> inflar sus entradas XML. Cubre magic-bytes/spoofing, XXE/XInclude (incl. UTF-16 y sin
> prólogo), traversal (`../`/UNC), pixel-flood y el sobre de lote agregado. **Falta la
> contención por PROCESO** (worker con rlimits + timeout) — difiere a la infra.

| Caso común | Crit | Defensa / postura | Capa | Milestone | Estado |
|---|:--:|---|:--:|:--:|:--:|
| **Esquema de TODO input con Zod en la frontera** | alta | convención `safeParse(body/query/params) → 400` como parte del esqueleto de API | 6 | M0 | 📝 |
| **Firma de webhooks entrantes** (spoofing/replay) | alta | cadena completa de docs/13 §4 (crudo → unwrap → frescura → dedupe → idempotencia) | 1 | M0/M3 | 🟡 |
| **XXE/SSRF en XML del CFDI** | alta | parser sin entidades externas ni DTD; correr fixtures maliciosos (§4bis) | 6 | M4 | 🟡 |
| **ZIP-bomb / path traversal / sobre de lote agregado** | alta | ratio agregado + timeout de lote (60 archivos chicos = bomba) | 6 | M4 | 🟡 |
| **Content-type spoofing / magic bytes** | alta | validar por **magic bytes** contra lista blanca, nunca por extensión ni `Content-Type` | 6 | M4 | 📝 |
| **Inyección de prompt en el intake** (texto libre = dato, no orden) | alta | defensa **construida** (sanitizar + estructura); **falta el test** del §10 (idea/regla como inyección → no se refleja en spec) | 6 | M1 (test) | 🟡 |
| Validación de la SALIDA del LLM (quality gate) | alta | coherencia + verifier + `resolverVista` tratan la salida como best-effort | 6 | **M0/M1.5** | ✅ |
| Inyección SQL / queries parametrizadas | alta | siempre `$1`, nunca template string; `CHECK` constraints en DB | 7 | M0+ | ✅ |
| Límites de tamaño/longitud/tipo (anti-amplificación) | media | topes en la capa de modelo (**hechos**) + tope de request/upload en la frontera | 6 | M0/M4 | 🟡 |
| Nunca confiar en el cliente (autoridad del servidor) | media | flags/rol/org derivados de la sesión, no del body | 3 | M2 | 🟡 |
| Encoding de salida / XSS (strings de IA reflejados) | media | el vector no es la UI (React escapa) sino el **correo HTML** y su asunto; escapar + anti-inyección de cabecera | 6 | M3 (email) | 🟡 |
| **Cabeceras de seguridad** (CSP/HSTS/X-Content-Type-Options) | media | configurar explícitamente (Next+Clerk no las pone todas) | 2 | M0/M2 | 📝 |
| Egress/SSRF de OCR + pixel-flood en imágenes | media | diferido (M5); el pixel-flood (M4) aterriza **antes** que el OCR | 6 | M4/M5 | 🟡 |

> **Actualización (2026-07-26) — filas ya implementadas (código):**
> - **Firma de webhooks entrantes** → ✅ `core/src/webhooks/firma.ts:38` (HMAC crudo,
>   standard-webhooks + Stripe, `timingSafeEqual`, ±5 min). `verify:webhooks`.
> - **XXE/SSRF en XML del CFDI** y **ZIP-bomb / path traversal / sobre de lote** → ✅ gate
>   construido Y cableado: `core/src/entrada/validador.ts` (XXE incl. dentro de XLSX inflado;
>   zip-bomb inflando de verdad con `node:zlib`) + `core/src/entrada/puente.ts:62`, `:77`.
>   `verify:entrada`, `verify:entrada:gate`.
> - **Content-type spoofing / magic bytes** → ✅ (pasa de 📝): valida por magic bytes contra
>   lista blanca y caza ejecutable disfrazado (`core/src/entrada/validador.ts:54`, `:58`).
> - **Límites de tamaño/longitud/tipo** y **Nunca confiar en el cliente** → ✅: topes de la
>   capa de modelo + tope de upload/lote en la frontera (`core/src/entrada/puente.ts:50`,
>   `:70`); flags/rol/org derivados de la sesión y de la ruta, nunca del body
>   (`core/src/http/pipeline.ts:78`).
> - **Pixel-flood** → ya cubierto por el gate (M4), como afirma la propia fila del OCR.
> Siguen 🟡/📝: el **test** de inyección de prompt del intake (la defensa existe; falta el
> test), las **cabeceras de seguridad** (CSP/HSTS) explícitas, el **email HTML/XSS** (M3) y el
> **egress de OCR** (M5, tras mini-spike).

---

## Los 7 huecos que abrió esta auditoría (📝 → agendados)

Ninguno es un bug de lo construido; son casos comunes que **faltaba declarar o
agendar**. Ya reflejados en [plan-fase-1](plan-fase-1.md) y en el checklist de
[docs/11 §10](11-threat-model.md):

1. **CSRF** de la sesión — nueva capa 2 del pipeline (M2).
2. **Session fixation** — declarar rotación de Clerk como asunción verificada (checklist).
3. **Brute-force/credential stuffing** — activar y verificar la protección de Clerk (M2).
4. **OAuth/social login** — decisión de alcance del MVP (M2).
5. **Cobertura uniforme de autorización** — `withAuthz` obligatorio + test enumerador de rutas (M2).
6. **Rate-limit genérico por IP/org** — elegir store y cablear en middleware (M2). *El más flaco.*
7. **Pooling de Neon vs `SET LOCAL`** — probar aislamiento contra la URL del pooler, no solo local (M2). *La más crítica.*

> **Actualización (2026-07-26) — 3 de los 7 ya cerrados en código:**
> - **#1 CSRF** → ✅ capa 2 del pipeline (`core/src/http/pipeline.ts:71-75`, fail-closed).
>   `verify:http`.
> - **#5 Cobertura uniforme de autorización** → ✅ `withEfecto` obligatorio + enumerador de
>   rutas (`core/src/http/pipeline.ts:106`, `core/scripts/verify-rutas.ts`). `verify:rutas`.
> - **#6 Rate-limit genérico** → ✅ la capa está construida (`core/src/http/pipeline.ts:60-61`)
>   y el store (Upstash, fail-closed) cableado (`web/lib/automata/wiring.ts:53`); resta afinar
>   cubetas por-org y WAF.
> Siguen abiertos por *configuración/despliegue* (no código): #2 session fixation, #3
> brute-force y #4 OAuth (config de Clerk + checklist), y **#7 pooling de Neon** (probar contra
> la URL del pooler) — la más crítica.

## Regla operativa

**Ningún endpoint con efecto se expone sin pasar las 8 capas del pipeline.** El
`withAuthz` (capa 4) y la validación Zod (capa 6) se construyen en M0 como parte del
esqueleto para que sean el **camino por defecto**, no un `assertCan` suelto que se
pueda olvidar. La joya —aislamiento por org (capa 7)— ya es imposible de evadir y está
probada; el resto es correcto por diseño y se materializa milestone a milestone.
