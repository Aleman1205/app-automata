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

---

## 1. Autenticación — veredicto: huecos menores

Diseño sólido (Clerk: sesión corta auto-refrescada, MFA obligatoria admin/facturación,
step-up, membresía viva). **Casi nada construido**: Clerk aún no es dependencia, no hay
`middleware.ts` ni verificación server-side del JWT. Varios vectores canónicos estaban
**sin declarar** (se delegaban a Clerk en silencio).

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

---

## 2. Autorización — veredicto: huecos menores

Las **primitivas están probadas**: `assertCan` (matriz de rol + cross-org) y
`leerMembresia` tienen test unitario (`verify-auth.ts`) e integración real contra
Postgres (`verify-pg.ts`). El hueco: **nada está cableado** — los únicos importadores
son los scripts `verify-*`. Faltan los controles *estructurales* de OWASP API que
evitan el olvido.

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

---

## 3. Rate limiting / abuso de recursos — veredicto: **huecos serios**

Bien pensado en papel (docs/11 §8, docs/06 §3-4, docs/10 §8, docs/03 §5) pero **casi
nada construido**, y el schema M2 aún no tiene columnas de contador. Es el dominio
donde el **dinero** se protege: el build cuesta **~$1.8** y el Run **<1¢** (corregido;
ver §8 de docs/11). El genérico por IP/org es el más flaco: solo vive en prosa.

| Caso común | Crit | Defensa / postura | Capa | Milestone | Estado |
|---|:--:|---|:--:|:--:|:--:|
| **Rate-limit por IP/usuario/org en endpoints** (API4) | alta | **elegir store** (Upstash Ratelimit / Vercel WAF) y cablear en middleware **antes** de exponer cualquier endpoint | 0 | M2 | 📝 |
| **Wallet-DoS por disparo de builds** (~$1.8 c/u) | alta | cap **2× espacios/mes** por org; **construir tabla `intakes` + contador mensual** y aplicarlo en la tx de aprobación | 0 | M3 | 🟡 |
| **Corte de gasto por build $10** + presupuesto acumulado entre reintentos | alta | `task_budget` en la sesión CMA + contador USD acumulado que **corte** | 7 | M3 | 🟡 |
| **Tope de ejecuciones del Run que CORTE** (no solo alarme) | alta | contador mensual por org + corte duro con opción de subir plan (decisión #3 de §8) | 0 | M3 | 🟡 |
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
| Hijack de función RLS vía `search_path`/`SECURITY DEFINER` | baja | opcional: fijar `search_path` si la función pasa a `SECURITY DEFINER` | 7 | — | ✅ |

---

## 5. Validación server-side — veredicto: huecos menores

La validación **de la capa de modelo** (intake + planner) está **construida y es
determinista**: `validarSpec` (topes de longitud/reglas), `sanitizar` (strip `<>`),
puerta de coherencia con reintentos, `resolverVista` como quality gate. Las queries
son **parametrizadas**. La validación **de frontera HTTP** está bien documentada pero
sin construir (no hay capa HTTP). Zod es hoy solo dep transitiva del SDK.

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

## Regla operativa

**Ningún endpoint con efecto se expone sin pasar las 8 capas del pipeline.** El
`withAuthz` (capa 4) y la validación Zod (capa 6) se construyen en M0 como parte del
esqueleto para que sean el **camino por defecto**, no un `assertCan` suelto que se
pueda olvidar. La joya —aislamiento por org (capa 7)— ya es imposible de evadir y está
probada; el resto es correcto por diseño y se materializa milestone a milestone.
