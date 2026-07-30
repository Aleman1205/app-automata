import { cronAjustes } from "@/lib/automata/wiring";

// GET/POST /api/cron/ajustes — drena la cola de ajustes que /ajustar encoló: corre la regresión y
// abre la sesión de CMA para la versión siguiente. Cada 2 min, como el disparo de builds.
export const GET = cronAjustes;
export const POST = cronAjustes;
