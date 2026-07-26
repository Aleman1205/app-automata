import { ruta } from "@/lib/automata/wiring";
import { crearAutomatizacionEP } from "automata-core/http/endpoints";

// POST /api/orgs/:orgId/automatizaciones — crear una automatización (admin).
export const POST = ruta(crearAutomatizacionEP);
