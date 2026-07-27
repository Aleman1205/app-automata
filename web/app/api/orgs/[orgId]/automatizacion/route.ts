import { ruta } from "@/lib/automata/wiring";
import { verAutomatizacionEP } from "automata-core/http/endpoints";

// GET /api/orgs/:orgId/automatizacion?id=<uuid> — detalle de UNA automatización (versiones +
// ciclo + vista de la última versión lista). Acción "ver" (admin/operador), RLS por org.
export const GET = ruta(verAutomatizacionEP);
