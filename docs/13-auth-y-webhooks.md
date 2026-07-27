# 13 — Autenticación, autorización y verificación de webhooks

> **Diseñado** (2026-07-21, ex-stub). El modelo de amenazas ([docs/11](11-threat-model.md))
> descubrió que estas superficies se daban por diseñadas sin estarlo. Aquí queda
> el diseño concreto y buildable. **Cuándo aterriza** (ver
> [docs/plan-fase-1.md](plan-fase-1.md)): la firma del webhook de CMA en **M0**
> (ahí ya recibes su callback); auth + autorización en **M2**; firma de Stripe +
> entitlements en **M3**.

---

## Estado de implementación (2026-07-26)

> **IMPLEMENTADO en Fase 1.** El motor real vive en `core/` (framework-agnóstico,
> TS+tsx) y el wiring de Next 16 en `web/`. Lo de esta sección ya está construido y
> verde en la suite `verify:*` (typecheck + `next build` OK). Lo que sigue siendo
> plan se marca al final; las afirmaciones que la implementación volvió falsas llevan
> una nota **Actualización:** en línea, en su sección.

**El pipeline de 8 capas (§3) — construido, en un solo camino.** La cadena vive
completa en `autorizar()` (`core/src/http/pipeline.ts:51`), fail-closed en cada capa,
y `withEfecto()` le cuelga validación (esquema) + handler DENTRO de la misma tx
`conOrg` (`core/src/http/pipeline.ts:106`). El orden real **corrige** el del diseño:
la autorización (membresía VIVA → `assertCan` → step-up) corre DENTRO de `conOrg` y
ANTES de step-up y validación, para que un no-miembro reciba 403 uniforme sin poder
enumerar esquemas ni provocar prompts de MFA (`pipeline.ts:81-96`). Traduce
`NoAutorizado`→403, `CuotaExcedida`→402, `ServicioSuspendido`→503 (`pipeline.ts:98-103`);
step-up con doble cota anti clock-skew: un `mfaVerificadoEn` en el FUTURO no cuenta
(`pipeline.ts:90-93`). Prueba: `verify:http` (8 capas E2E, IDOR cross-org, y los
fail-closed que cazó la revisión: CSRF sin Origin, step-up con timestamp futuro,
invitar-admin exige MFA).

**El adaptador Request→Response y el upload binario — construidos.** `adaptar()`
traduce entre el `Request` web y la `Solicitud` framework-agnóstica sin tomar NINGUNA
decisión de seguridad (`core/src/http/adaptador.ts:71`); el `orgId` llega de la RUTA,
nunca del cuerpo (anti IDOR/confused deputy). `adaptarUpload()` pasa por las MISMAS
capas vía `autorizar()` pero sin materializar el cuerpo — es el archivo, lo lee el
gate dentro de la tx (`adaptador.ts:108`). El error inesperado → 500 genérico sin
stack, nunca 200. Pruebas: `verify:adaptador:pg`; y la garantía anti-olvido de §3 es
real: `verify:rutas` escanea `web/app/api/**/route.ts` y falla si un verbo mutante no
pasa por `ruta()`.

**Los webhooks (§4) — construidos.** La cadena firma → parse → recurso firmado →
dedupe+despacho ATÓMICO vive en `recibir()` (`core/src/webhooks/receptor.ts:80`): el
INSERT de idempotencia y el efecto del handler commitean/rollbackean JUNTOS, así un
handler que falla LIBERA el id para el reintento (at-least-once, no at-most-once —
`receptor.ts:110-130`). Firma HMAC-SHA256 sobre el cuerpo CRUDO, comparación de tiempo
CONSTANTE y ventana ±5 min, para standard-webhooks/Svix (CMA) y Stripe
(`core/src/webhooks/firma.ts:62,98`). La org SIEMPRE se deriva del recurso FIRMADO por
resolvers SECURITY DEFINER, jamás del `organization_id` del payload (`receptor.ts:48-73`).
Pruebas: `verify:webhooks` (firmas válidas/inválidas ancladas al KAT oficial de
standard-webhooks + el receptor) y `verify:webhooks:handlers:pg`.

**Rol `automata_webhook` + resolvers SECURITY DEFINER — construidos.** El pool de
webhooks corre con un rol DEDICADO no-super, no-dueño, sujeto a FORCE RLS
(`core/db/schema.sql:514-520`), con privilegios MÍNIMOS (`schema.sql:524-534`). Como
no puede leer cross-org por sí mismo, descubre la org con `resolver_sesion_cma` /
`resolver_org_stripe` (SECURITY DEFINER, `REVOKE EXECUTE ... FROM PUBLIC`,
`schema.sql:501-509,536`), luego fija `app.current_org` y reusa
`confirmarAjuste`/`fallarAjuste` bajo RLS. El wiring lo cablea con
`crearPoolApp(DATABASE_URL_WEBHOOK)` (`web/lib/automata/wiring.ts:116`), NO con el rol
dueño — antes se usaba dueño y los handlers eran no-op bajo FORCE RLS (hallazgo ALTA de
la revisión). `verify:webhooks:handlers:pg` corre justamente como este rol no-super,
no como superusuario, para cazar de verdad ese no-op silencioso.

**Guard MONÓTONO de Stripe — construido (más allá del diseño).** El diseño solo
preveía frescura ±5 min contra replay; la implementación añade además un guard
anti out-of-order: el UPDATE solo aplica si el `created` del evento es ESTRICTAMENTE
más nuevo que el último aplicado (`ultimo_evento_ts`), así un `payment_failed`
retrasado NO regresa a `morosa` una org que ya pagó (`core/src/webhooks/handlers.ts:111-114`;
columna `subscriptions.ultimo_evento_ts` en `schema.sql:176`).

**Incidentes durables vía `app_registrar_incidente` — construidos.** Único camino de
escritura de la tabla append-only `incidentes` (app y webhook tienen `REVOKE ALL`):
SECURITY DEFINER, anti-forge (si hay contexto de org, ESE manda sobre el `p_org`, así
el app bajo `conOrg` no puede atribuir a otra org), `actor = session_user`
(`core/db/schema.sql:542-549`). Los handlers de webhook lo usan para el tipo
`webhook_desconocido` (build que podría colgarse) y para `pago_no_entregado` (idle de
CMA tras el reaper: entregable pagado no entregado) (`core/src/webhooks/handlers.ts:43,58`).
Prueba: `verify:incidentes:pg`.

**Sigue como PLAN (no implementado como código):** activación en producción (secretos
en Vercel/Neon, alta de los endpoints de webhook en las consolas de CMA/Stripe); el
CAMBIO DE PLAN de Stripe (necesita el `price` del evento o re-fetch al SDK —
`handlers.ts:88-90`) y la discriminación entre productos del mismo customer;
OAuth/social login sigue como decisión de alcance del MVP (§1).

---

## 1. Autenticación (Clerk)

**Proveedor: Clerk** (PLAN.md §2). No construimos contraseñas ni sesiones a mano.

**Decisiones fijadas** (de [docs/11](11-threat-model.md) §6):
- **MFA obligatoria** para el rol `admin` y para toda acción de facturación.
  "Disponible" no basta: se exige.
- **Invalidación remota** de todas las sesiones de un usuario (runbook de
  incidentes, docs/11 §11).
- Recuperación de cuenta por el flujo de Clerk, con MFA en el reset.

**Diseño (lo que estaba "por diseñar"):**

| Parámetro | Decisión |
|---|---|
| **Token de sesión** | Corto (~60 min), auto-refrescado por Clerk |
| **Vida máxima de sesión** | 7 días con "recordarme"; sin él, termina al cerrar el navegador |
| **Timeout por inactividad** | 24 h |
| **Step-up MFA** (re-verificación dentro de una sesión viva) | Obligatorio para las acciones peligrosas: cambiar facturación, borrar org, **cambiar miembros (invitar o quitar)**, exportar código. La sesión estar viva NO basta para estas. (`invitar` entró tras la revisión del wrapping: añadir un admin con una cookie robada sin poder pasar MFA sería escalada.) La política vive en un solo `Record` exhaustivo (`core/src/auth/roles.ts`): una acción nueva no compila sin clasificar su step-up. |

**Expulsión de un usuario de una org (el caso que faltaba).** Un usuario puede
pertenecer a varias orgs, así que expulsarlo de UNA no mata todas sus sesiones.
La garantía es otra: **la autorización se comprueba contra la membresía VIVA en
cada request** (§2), no contra un claim horneado en el token. Al quitar la
membresía → el siguiente request a datos de esa org da 403. Además, para el
runbook de incidentes, se puede **revocar las sesiones** del usuario (belt &
suspenders). La membresía viva es el control portante; la revocación es el extra.

**Casos delegados a Clerk — declarados, no asumidos.** La auditoría (docs/14 §1)
encontró vectores canónicos que Clerk cubre pero que aquí no se decían; se declaran
para poder **verificarlos** en el checklist ([docs/11 §10](11-threat-model.md)), no
darlos por hechos:

| Caso | Postura (a verificar, no asumir) |
|---|---|
| **Almacenamiento del token** | Cookie `httpOnly` + `Secure` + `SameSite` (default de Clerk). **Prohibido** el token de sesión en query string / URL (fuga por logs/referer/historial), en línea con la regla de privacidad del proyecto. |
| **Session fixation** | Clerk **rota el id de sesión al login** — asunción a confirmar en el checklist. |
| **Brute-force / credential stuffing** | Bot-protection + rate-limit **nativos de Clerk activados** (capa 0). Considerar lockout/backoff para el ICP PyME-MX. |
| **Verificación del JWT** | En el **servidor**, en cada request, vía **JWKS** de Clerk (no secreto compartido), tolerante a rotación de llaves. Es el control **portante**: sin él, `assertCan` y RLS son evadibles. |
| **OAuth / social login** | **Decisión de alcance del MVP** (Google es típico en PyME-MX). Si entra: verificación vía JWKS. Si no: declararlo fuera (distinto de "sin integraciones OAuth de terceros", que es otra cosa). |
| **Secretos de auth** | Signing keys de Clerk/webhooks y DB del rol de app: inventario + rotación. **El repo es público** → jamás en git. |

## 2. Autorización intra-organización

Dos roles `admin` / `operador` ([docs/04](04-multitenancy.md) §3). **RLS filtra
por `org_id`, NO por rol** — la comprobación de rol vive en la aplicación.

| Acción | admin | operador |
|---|:---:|:---:|
| Ejecutar una automatización, descargar resultado | ✅ | ✅ |
| Crear / ajustar / disparar build | ✅ | ❌ |
| Invitar / quitar gente | ✅ | ❌ |
| Facturación, plan, borrar org | ✅ | ❌ |

**Mecanismo de enforcement (concreto, para que sea buildable):**
- **Fuente de verdad del rol: una tabla propia `memberships` (`org_id, user_id,
  role`)**, no solo el claim de Clerk (que puede quedar stale). Se lee por request.
- **Un solo helper server-side `assertCan(user, org, accion)`** que se llama al
  **inicio de cada API route / server action con efecto** — no repartido, no en
  la UI. Ocultar un botón NO es seguridad; es cosmética.
- La UI puede ocultar lo que el rol no permite (buena UX), pero **cada endpoint
  con efecto vuelve a comprobar** con `assertCan`.
- **Revocación de membresía**: `DELETE` en `memberships` → el siguiente request
  del ex-miembro a esa org da 403 (por la comprobación viva de arriba).
- Verificado en el checklist de docs/11 §10 (operador dispara build → 403;
  operador toca facturación → 403; ex-miembro revocado pierde acceso).

## 3. El ciclo de vida de una request (cómo se apilan las capas)

Toda request con efecto pasa, en orden, por estas **8 capas** (la matriz completa
de casos comunes por capa está en [docs/14](14-controles-de-seguridad.md)):

```
0. Rate limit / WAF   → ¿demasiadas peticiones? (por IP y por org)      → 429
1. Clerk (authn)      → ¿quién es? JWT verificado en el SERVIDOR         → 401
2. CSRF / Origin      → ¿la mutación viene de nuestro origen?            → 403
3. Contexto org       → ¿en qué org? de la SESIÓN, nunca de un header del cliente
4. assertCan (authz)  → ¿su rol permite esta acción aquí? membresía VIVA → 403
5. step-up MFA        → ¿acción peligrosa? re-verificar el factor        → challenge
6. Validación (Zod)   → ¿body/query/params válidos, con allowlist?       → 400
7. Query con el ROL DE APP no-dueño → RLS filtra por org_id (docs/04 §2)
```

Las capas **4** y **7** son distintas y **ambas** hacen falta: `assertCan` es el
**rol** (qué puede hacer), RLS es el **aislamiento** (a qué org pertenece el dato). Un
bug en una no debe abrir la otra. Las capas **0, 2 y 6** (rate-limit, CSRF, validación)
se añadieron tras la auditoría de 2026-07-21 (docs/14): eran controles reales que no
figuraban como escalón explícito.

**Garantía anti-olvido.** El mayor riesgo práctico (BFLA/BOLA de OWASP) no es la
lógica sino **olvidar** una capa en un endpoint nuevo. Por eso el pipeline se
implementa como un **wrapper obligatorio (`withAuthz`)**, no como llamadas sueltas, y
un **test enumera el árbol de rutas** y falla si alguna con efecto no pasa por él. El
webhook entrante (§4) se salta 0–6 pero se autentica por **firma HMAC** y deriva su
org del **recurso firmado**, no del payload (anti *confused deputy*).

**Actualización (2026-07-26):** el wrapper obligatorio se implementó como `withEfecto`
(endpoints JSON) sobre `autorizar` (la cadena compartida de 8 capas, que también sirve
el upload binario vía `adaptarUpload`), no con el nombre `withAuthz`. El test que
enumera el árbol de rutas y falla si un verbo mutante se salta el camino es
`verify:rutas`. Ver `core/src/http/pipeline.ts:51,106` y
`core/src/http/adaptador.ts:108`.

## 4. Verificación de firma de webhooks

Dos emisores, dos secretos. Hoy solo existe el dedupe por `event.id`
([docs/03](03-pipeline-build.md) §3); falta la firma **antes** del dedupe.

**Actualización (2026-07-26):** ya no falta. La firma va **antes** del dedupe, dentro
de `recibir()` (`core/src/webhooks/receptor.ts:80`): firma sobre el cuerpo crudo →
parse → dedupe atómico (`webhook_events`, PK `(fuente, id)` — `schema.sql:282-288`) →
despacho en la MISMA tx. Construido y probado (`verify:webhooks`).

| Emisor | Secreto | Riesgo si no se verifica | Aterriza en |
|---|---|---|---|
| **CMA** (build terminado) | `ANTHROPIC_WEBHOOK_SIGNING_KEY` (`whsec`, [docs/07](07-entornos-despliegue.md) §5) | Un externo POSTea un `session.status_idled` falso y avanza un build ajeno | **M0** |
| **Stripe** (pago, plan) | Signing secret de Stripe | Un externo "confirma" un pago que no ocurrió → plan/cuota gratis | **M3** |

**La cadena completa, en orden (romperla = agujero):**

```
1. Leer el CUERPO CRUDO (re-serializar el JSON ROMPE la firma)
2. Verificar la firma HMAC con el SDK
     · CMA: webhooks.unwrap  · Stripe: constructEvent
   → inválida → 401 y descarte (sin filtrar por qué)
3. Verificar frescura del timestamp (ventana ±5 min)
   → viejo → 400  (esto para el REPLAY de un evento válido pasado)
4. Dedupe por event.id (idempotencia)
   → ya visto → 200 y no reprocesar (que dejen de reintentar)
5. Procesar de forma IDEMPOTENTE por (automation_id, version_id) (docs/03 §3)
   → si el proceso falla DESPUÉS de la firma → 5xx para que reintenten
     (la idempotencia evita el doble-procesado en el reintento)
```

**Actualización (2026-07-26) — el webhook de CMA es THIN.** El paso 5 **no procesa el
resultado en línea**, porque el webhook de CMA NO dice si el build pasó. Los `data.type`
reales son `session.status_idled`, `session.status_terminated` y
`session.outcome_evaluation_ended` (`core/src/webhooks/handlers.ts:20-22`); se **descartó**
el supuesto previo de un `session.completed`/`succeeded` que trajera el desenlace. El
ÉXITO solo se sabe **re-consultando la sesión** (sus `outcome_evaluations`), no por el
evento. Por eso el despacho es en dos tiempos: un `status_idled` sobre una versión
`building` se **encola en el outbox `cosecha_pendiente`** (idempotente por `session_id`)
y un **drainer** (rol dueño, FUERA de la tx del receptor, para que el I/O a CMA/R2 no
cuelgue el pool) hace el fetch + `confirmarAjuste`; `status_terminated` falla el ajuste
in-tx; un tipo desconocido levanta un incidente y hace no-op (falla seguro). Ver
`core/src/webhooks/handlers.ts:35-75`; pruebas en `verify:webhooks:handlers:pg`.

**Notas de implementación (Next 16):**
- La API route del webhook debe leer el **cuerpo crudo** (`await req.text()`),
  con el parseo de body **desactivado** — el parser por default re-serializa y
  rompe la firma. Verificar firma sobre el crudo, luego `JSON.parse`.
- La firma sola NO detiene el replay de un evento válido capturado: por eso el
  **timestamp fresco + idempotencia** son parte de la cadena, no opcionales.

## 5. Pagos → entitlements (el contrato con auth)

El detalle de billing es de negocio (se aborda con M3); aquí solo lo que toca a
autorización:
- Stripe aloja las tarjetas; **nunca** guardamos datos de pago en nuestra base.
- El **estado de suscripción es de Stripe** (fuente de verdad); llega por webhook
  firmado (§4) y se refleja en una tabla `subscriptions` (org_id, plan, estado).
- **Entitlements** (qué plan, qué features, qué cuota de ejecuciones — holgada,
  [docs/decisiones-runtime.md](decisiones-runtime.md) #3) se **derivan de esa
  tabla y se comprueban por acción**, igual que el rol.
- **Fallo de pago** → periodo de gracia → suspensión de builds/ejecuciones (no de
  la lectura de resultados ya generados). El diseño fino, con M3.
