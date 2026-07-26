import { webhook } from "@/lib/automata/wiring";

// POST /api/webhooks/cma — fin de build de CMA. Cuerpo CRUDO + firma standard-webhooks.
// NO pasa por `ruta`/withEfecto: se autentica por firma HMAC (docs/13 §4).
export const POST = (req: Request) => webhook("cma", req);
