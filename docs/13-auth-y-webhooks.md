# 13 — Autenticación, autorización y verificación de webhooks

> **Diseñado** (2026-07-21, ex-stub). El modelo de amenazas ([docs/11](11-threat-model.md))
> descubrió que estas superficies se daban por diseñadas sin estarlo. Aquí queda
> el diseño concreto y buildable. **Cuándo aterriza** (ver
> [docs/plan-fase-1.md](plan-fase-1.md)): la firma del webhook de CMA en **M0**
> (ahí ya recibes su callback); auth + autorización en **M2**; firma de Stripe +
> entitlements en **M3**.

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
| **Step-up MFA** (re-verificación dentro de una sesión viva) | Obligatorio para las acciones peligrosas: cambiar facturación, borrar org, quitar miembros, exportar código. La sesión estar viva NO basta para estas. |

**Expulsión de un usuario de una org (el caso que faltaba).** Un usuario puede
pertenecer a varias orgs, así que expulsarlo de UNA no mata todas sus sesiones.
La garantía es otra: **la autorización se comprueba contra la membresía VIVA en
cada request** (§2), no contra un claim horneado en el token. Al quitar la
membresía → el siguiente request a datos de esa org da 403. Además, para el
runbook de incidentes, se puede **revocar las sesiones** del usuario (belt &
suspenders). La membresía viva es el control portante; la revocación es el extra.

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

Toda request con efecto pasa, en orden, por:

```
1. Clerk         → ¿quién es? (autenticación; sesión válida, MFA si aplica)
2. Contexto org  → ¿en qué org actúa? (de la ruta / el header de org)
3. assertCan     → ¿su rol permite esta acción en esta org? (§2)  → 403 si no
4. step-up MFA   → ¿acción peligrosa? re-verificar (§1)           → challenge
5. Query con el ROL DE APP no-dueño → RLS filtra por org_id (docs/04 §2)
```

Las capas 3 y 5 son distintas y **ambas** hacen falta: `assertCan` es el **rol**
(qué puede hacer), RLS es el **aislamiento** (a qué org pertenece el dato). Un
bug en una no debe abrir la otra.

## 4. Verificación de firma de webhooks

Dos emisores, dos secretos. Hoy solo existe el dedupe por `event.id`
([docs/03](03-pipeline-build.md) §3); falta la firma **antes** del dedupe.

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
