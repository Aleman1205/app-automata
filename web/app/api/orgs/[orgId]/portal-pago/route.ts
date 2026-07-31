import { abrirPortalPago } from "@/lib/automata/wiring";

// POST /api/orgs/:orgId/portal-pago — portal de cliente de Stripe: cambiar tarjeta, ver facturas,
// cancelar. Solo para orgs que YA tienen suscripción; sin `stripe_customer_id` responde 409 y el
// front ofrece el checkout, que es lo que de verdad necesitan.
export async function POST(req: Request, ctx: { params: Promise<{ orgId: string }> }) {
  return abrirPortalPago(req, (await ctx.params).orgId);
}
