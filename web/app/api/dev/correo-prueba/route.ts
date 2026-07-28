import { DEV } from "@/lib/automata/dev";
import { enviarCorreoPrueba } from "@/lib/automata/wiring";

// GET /api/dev/correo-prueba?a=tu@correo.com — SOLO modo dev. Manda un correo de muestra vía
// Resend para confirmar que la llave + la plantilla funcionan, sin esperar a que corra un build.
// En producción → 404 (no es una ruta de producto).
export async function GET(req: Request) {
  if (!DEV) return new Response("no encontrado", { status: 404 });
  const a = new URL(req.url).searchParams.get("a");
  if (!a || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) {
    return Response.json({ error: "pasa ?a=tu@correo.com" }, { status: 400 });
  }
  try {
    await enviarCorreoPrueba(a);
    return Response.json({ ok: true, enviado_a: a });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
