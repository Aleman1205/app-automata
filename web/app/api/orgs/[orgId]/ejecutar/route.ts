import { correrAutomatizacion } from "@/lib/automata/wiring";

// POST /api/orgs/:orgId/ejecutar — el RUN real (multipart: automatizacionId + archivo).
// Camino sancionado APARTE (adaptarUpload → autorizar, las mismas 8 capas), como el upload.
// Corre el artefacto en el LocalPythonExecutor (DEV) y devuelve el Resultado resuelto. En
// producción el Run va en el runner aislado (gVisor/CMA) → 503 hasta desplegarlo.
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await ctx.params;
  return correrAutomatizacion(req, orgId);
}
