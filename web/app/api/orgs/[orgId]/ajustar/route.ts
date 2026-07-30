import { ruta } from "@/lib/automata/wiring";
import { pedirAjusteEP } from "automata-core/http/endpoints";

// POST /api/orgs/:orgId/ajustar — el cliente pide un cambio (o reporta una falla). Solo ENCOLA:
// la regresión (que decide si es cambio o reparación) y la sesión de CMA las corre el cron de
// ajustes fuera del request. Exige confirmado:true — el cliente tiene que haber visto el costo.
export const POST = ruta(pedirAjusteEP);
