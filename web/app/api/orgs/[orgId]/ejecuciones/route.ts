import { ruta } from "@/lib/automata/wiring";
import { listarEjecucionesEP } from "automata-core/http/endpoints";

// GET /api/orgs/:orgId/ejecuciones?id=<uuid> — historial de corridas de una automatización
// (para el detalle). Acción "ver" (admin/operador), RLS por org.
export const GET = ruta(listarEjecucionesEP);
