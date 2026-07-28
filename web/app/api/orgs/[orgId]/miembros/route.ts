import { ruta } from "@/lib/automata/wiring";
import { invitarEP, quitarMiembroEP, listarEquipoEP } from "automata-core/http/endpoints";

// GET    /api/orgs/:orgId/miembros — listar el equipo (ver, admin/operador).
// POST   /api/orgs/:orgId/miembros — invitar (admin, step-up MFA).
// DELETE /api/orgs/:orgId/miembros — quitar (admin, step-up; no deja la org sin admin).
export const GET = ruta(listarEquipoEP);
export const POST = ruta(invitarEP);
export const DELETE = ruta(quitarMiembroEP);
