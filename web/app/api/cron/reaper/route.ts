import { cronReaper } from "@/lib/automata/wiring";

// GET/POST /api/cron/reaper — barrido de builds colgados (a2). Vercel Cron lo invoca por GET
// con `Authorization: Bearer <CRON_SECRET>`. NO pasa por `ruta`/withEfecto: se autentica por
// el secreto del cron y corre con el pool DUEÑO (ops), no con el rol de app.
export const GET = (req: Request) => cronReaper(req);
export const POST = (req: Request) => cronReaper(req);
