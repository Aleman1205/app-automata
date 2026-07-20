# 13 — Autenticación, autorización y verificación de webhooks

> **Stub.** El modelo de amenazas ([docs/11](11-threat-model.md)) descubrió que
> estas superficies se daban por diseñadas sin estarlo. Aquí queda el esqueleto
> con las decisiones ya tomadas; se desarrolla cuando toque implementar auth.
> No es opcional para lanzar — es un hueco conocido con dueño.

---

## 1. Autenticación (toma de cuenta / spoofing)

**Proveedor: Clerk** (decidido en [PLAN.md](../PLAN.md) §2). No construimos
manejo de contraseñas ni sesiones a mano.

Decisiones ya fijadas (de [docs/11](11-threat-model.md) §6):

- **MFA obligatoria** para el rol `owner` y para cualquier acción de
  facturación. "Disponible" no basta: se exige.
- Sesiones: expiración e **invalidación remota** de todas las sesiones de un
  usuario (para el runbook de incidentes, [docs/11](11-threat-model.md) §11).
- Recuperación de cuenta: el flujo de Clerk, con MFA en el reset.

Por diseñar: duración exacta de sesión, política de "recordarme", qué pasa con
sesiones vivas cuando se expulsa a un usuario de una org.

## 2. Autorización intra-organización (elevación)

Roles `owner` / `member` / `viewer` definidos en
[docs/04](04-multitenancy.md) §3. **RLS filtra por `org_id`, no por rol** — la
comprobación de rol vive en la capa de aplicación y hay que hacerla en **cada
acción con efecto**, no solo al pintar la UI:

| Acción | owner | member | viewer |
|---|:---:|:---:|:---:|
| Ejecutar una automatización | ✅ | ✅ | ✅ |
| Crear / ajustar / disparar build | ✅ | ✅ | ❌ |
| Facturación, plan | ✅ | ❌ | ❌ |
| Invitar / expulsar, borrar org | ✅ | ❌ | ❌ |

- **Revocación de membresía**: expulsar a un ex-empleado corta su acceso de
  inmediato (invalida sus sesiones en esa org).
- Verificado en el checklist de [docs/11](11-threat-model.md) §10 (viewer
  intenta disparar build → 403; member intenta facturación → 403).

## 3. Verificación de firma de webhooks

Hoy solo existe el dedupe por `event.id` ([docs/03](03-pipeline-build.md) §3).
Falta el paso previo: **verificar la firma HMAC ANTES del dedupe**; firma
inválida → 401 y descarte.

Dos emisores, dos secretos:

| Emisor | Secreto | Riesgo si no se verifica |
|---|---|---|
| **CMA** (build terminado) | `ANTHROPIC_WEBHOOK_SIGNING_KEY` (`whsec`, [docs/07](07-entornos-despliegue.md) §5) | Un externo POSTea un `session.status_idled` falso y avanza un build ajeno |
| **Stripe** (pago, plan) | Signing secret de Stripe | Un externo "confirma" un pago que no ocurrió → plan/cuota gratis |

Ambos SDKs traen el verificador (`webhooks.unwrap` en el de Anthropic,
`constructEvent` en Stripe). La regla es no confiar en el cuerpo hasta que la
firma pase, y pasar el **cuerpo crudo** al verificador (re-serializar el JSON
rompe la firma).

## 4. Pagos (resumen — el detalle es de negocio)

- Stripe aloja las tarjetas; **nunca** guardamos datos de pago en nuestra base.
- Estados de suscripción, fallo de pago y su efecto sobre las ejecuciones: por
  diseñar junto con el billing (queda como docs/14 cuando se aborde).
