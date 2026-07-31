import { crearCheckoutPago } from "@/lib/automata/wiring";

// POST /api/orgs/:orgId/pagar — abre el checkout de Stripe para contratar un plan.
// NO cambia el plan: solo abre la caja. El plan lo aplica el webhook cuando Stripe confirma el
// pago, porque Stripe es la fuente de verdad de lo que el cliente realmente paga (docs/06).
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  return crearCheckoutPago(req, (await ctx.params).orgId);
}
