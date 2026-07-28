import { misOrgs } from "@/lib/automata/wiring";

// GET /api/yo — resuelve la org del usuario autenticado desde su membresía (y hace onboarding al
// vuelo si es su primer acceso). El front lo usa para saber a qué org pegar, en vez de una env
// clavada. Auth propia (rate + sesión Clerk), no org-scoped → no pasa por `ruta`/withEfecto.
export const GET = (req: Request) => misOrgs(req);
