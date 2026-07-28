import { ruta } from "@/lib/automata/wiring";
import { intakeEP } from "automata-core/http/endpoints";

// POST /api/orgs/:orgId/intake { idea, historial, turno } — una ronda del entrevistador
// (Sonnet, llamada directa). Devuelve la siguiente ronda de preguntas o el spec. Acción
// "crear_build" (admin), RLS por org (solo autoriza; el intake no usa la BD).
export const POST = ruta(intakeEP);
