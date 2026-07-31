import { ruta, avisarInvitacion } from "@/lib/automata/wiring";
import { invitarEP, quitarMiembroEP, listarEquipoEP } from "automata-core/http/endpoints";

// GET    /api/orgs/:orgId/miembros — listar el equipo (ver, admin/operador).
// POST   /api/orgs/:orgId/miembros — invitar (admin, step-up MFA).
// DELETE /api/orgs/:orgId/miembros — quitar (admin, step-up; no deja la org sin admin).
export const GET = ruta(listarEquipoEP);
export const DELETE = ruta(quitarMiembroEP);

// El POST ENVUELVE `ruta(invitarEP)` en vez de reimplementar la invitación: sigue habiendo UN SOLO
// camino de escritura (con sus 8 capas, su cuota y sus validaciones) y el correo es un efecto
// posterior. Antes la invitación se guardaba y NADIE le avisaba a la persona: se enteraba solo si
// por su cuenta se registraba con ese mismo correo — y mientras tanto ya le ocupaba un lugar del plan.
const invitar = ruta(invitarEP);
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  // El cuerpo se lee de una COPIA: `ruta` lo consume y un Request solo se puede leer una vez.
  const copia = req.clone();
  const res = await invitar(req, ctx);
  if (res.status !== 201) return res; // rechazada (rol, cuota, correo inválido): nada que avisar

  const correo = ((await copia.json().catch(() => ({}))) as { correo?: unknown }).correo;
  if (typeof correo === "string" && correo.trim()) {
    const { orgId } = await ctx.params; // de la RUTA, como todo lo demás: nunca del cuerpo
    await avisarInvitacion(orgId, correo.trim());
  }
  return res;
}
