import { descargarResultado } from "@/lib/automata/wiring";

// GET /api/orgs/:orgId/resultado?ejecucionId=… — devuelve el resultado de una corrida pasada.
// La clave del objeto se lee de la BD bajo RLS, nunca del query string.
export const GET = async (req: Request, ctx: { params: Promise<{ orgId: string }> }) => {
  const { orgId } = await ctx.params;
  return descargarResultado(req, orgId);
};
