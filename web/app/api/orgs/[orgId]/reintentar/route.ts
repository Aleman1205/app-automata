import { ruta } from "@/lib/automata/wiring";
import { reintentarEP } from "automata-core/http/endpoints";

// POST /api/orgs/:orgId/reintentar — rehacer un build que FALLÓ, sin volver a cobrar. Solo ENCOLA
// (reusa la cola de ajustes: el drainer ya sabe reconstruir desde spec + ejemplo_key). Las guardas
// de que sea gratis viven en app_solicitar_reintento, no aquí: nunca entregada, última versión
// fallida y con insumos guardados.
export const POST = ruta(reintentarEP);
