import { subirEjemplo } from "@/lib/automata/wiring";

// POST /api/orgs/:orgId/ejemplo — sube el archivo de ejemplo (multipart, campo 'archivo') a R2.
// Camino sancionado aparte del pipeline JSON: pasa por las MISMAS 8 capas (autorizar) + el gate
// de entrada ANTES de guardar. Devuelve { ejemploKey } que POST /construir consume.
export const POST = async (req: Request, ctx: { params: Promise<{ orgId: string }> }) => {
  const { orgId } = await ctx.params;
  return subirEjemplo(req, orgId);
};
