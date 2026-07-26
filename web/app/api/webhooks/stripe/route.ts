import { webhook } from "@/lib/automata/wiring";

// POST /api/webhooks/stripe — eventos de facturación. Cuerpo CRUDO + firma Stripe.
// NO pasa por `ruta`/withEfecto: se autentica por firma HMAC (docs/13 §4).
export const POST = (req: Request) => webhook("stripe", req);
