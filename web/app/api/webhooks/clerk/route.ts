import { webhookClerk } from "@/lib/automata/wiring";

// POST /api/webhooks/clerk — alta de usuario (user.created) → onboarding automático (org + plan
// base + admin). Cuerpo CRUDO + firma Svix/standard-webhooks. NO pasa por `ruta`/withEfecto: se
// autentica por firma HMAC (mismo camino que los webhooks de CMA/Stripe, docs/13 §4).
export const POST = (req: Request) => webhookClerk(req);
