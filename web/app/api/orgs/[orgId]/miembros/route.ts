import { ruta } from "@/lib/automata/wiring";
import { invitarEP, quitarMiembroEP } from "automata-core/http/endpoints";

// POST   /api/orgs/:orgId/miembros — invitar (admin, step-up MFA).
// DELETE /api/orgs/:orgId/miembros — quitar (admin, step-up; no deja la org sin admin).
export const POST = ruta(invitarEP);
export const DELETE = ruta(quitarMiembroEP);
