import { ruta } from "@/lib/automata/wiring";
import { congelarEP } from "automata-core/http/endpoints";

// POST /api/orgs/:orgId/congelar { id } — hacer definitiva una automatización (admin, acción
// "ajustar"). No congela con un cambio en vuelo (409). RLS por org.
export const POST = ruta(congelarEP);
