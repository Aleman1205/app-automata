import { ruta } from "@/lib/automata/wiring";
import { solicitarBuildEP } from "automata-core/http/endpoints";

// POST /api/orgs/:orgId/construir — encola un disparo de build (a3-s6): spec aprobada +
// ejemplo ya subido. El planner + arrancarConstruccion los corre el cron de disparo.
export const POST = ruta(solicitarBuildEP);
