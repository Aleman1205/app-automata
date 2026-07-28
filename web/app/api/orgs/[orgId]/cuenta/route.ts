import { ruta } from "@/lib/automata/wiring";
import { verCuentaEP } from "automata-core/http/endpoints";

// GET /api/orgs/:orgId/cuenta — plan + límites + consumo del periodo (panel de cuenta).
// Acción "ver" (admin/operador), RLS por org.
export const GET = ruta(verCuentaEP);
