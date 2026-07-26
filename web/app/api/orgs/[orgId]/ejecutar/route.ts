import { ruta } from "@/lib/automata/wiring";
import { ejecutarEP } from "automata-core/http/endpoints";

// POST /api/orgs/:orgId/ejecutar — ejecutar una automatización (admin y operador).
export const POST = ruta(ejecutarEP);
