import { cronDisparo } from "@/lib/automata/wiring";

// GET/POST /api/cron/disparo — drena las solicitudes de build encoladas (a3-s6): corre el
// planner y arranca el build en CMA. Vercel Cron lo invoca por GET con Bearer CRON_SECRET.
// Corre con el pool DUEÑO; no pasa por `ruta`/withEfecto (se autentica por el secreto del cron).
export const GET = (req: Request) => cronDisparo(req);
export const POST = (req: Request) => cronDisparo(req);
