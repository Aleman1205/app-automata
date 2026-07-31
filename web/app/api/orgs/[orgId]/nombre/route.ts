import { ruta } from "@/lib/automata/wiring";
import { renombrarOrgEP } from "automata-core/http/endpoints";

// POST /api/orgs/:orgId/nombre — renombrar el equipo (admin, sin step-up).
// La org nace autogenerada y ese nombre sale en la UI, en los correos del ciclo y en el ASUNTO de
// la invitación que le mandamos a gente que aún no es cliente. El saneo del texto (controles,
// longitud) vive en el esquema del endpoint, no aquí.
export const POST = ruta(renombrarOrgEP);
