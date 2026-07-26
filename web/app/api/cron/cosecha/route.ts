import { cronCosecha } from "@/lib/automata/wiring";

// GET/POST /api/cron/cosecha — drena el outbox de cosecha (a3): cosecha en CMA, sube a R2 y
// confirma. Vercel Cron lo invoca por GET con `Authorization: Bearer <CRON_SECRET>`. Corre con
// el pool DUEÑO; no pasa por `ruta`/withEfecto (se autentica por el secreto del cron).
export const GET = (req: Request) => cronCosecha(req);
export const POST = (req: Request) => cronCosecha(req);
