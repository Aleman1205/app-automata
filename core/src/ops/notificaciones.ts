// ─────────────────────────────────────────────────────────────────────────────
// Notificaciones por correo del CICLO del producto (docs/05): avisos transaccionales sobre
// LAS automatizaciones del cliente — "ya está lista", "necesita revisión". NO son reportes
// programados ni entrega de datos vivos (eso sería Fase 3 / Zapier, fuera de alcance).
//
// Puerto INYECTABLE (como Storage/StateRepo): el core define el contrato + las PLANTILLAS
// (puras, vendor-agnósticas, testeables sin llaves); el wiring provee la impl real (Resend +
// resolver el correo del destinatario por Clerk). La cosecha lo llama BEST-EFFORT: si el correo
// falla, el build YA quedó — nunca se tumba por un correo.
// ─────────────────────────────────────────────────────────────────────────────

export type TipoCorreo = "lista" | "fallo" | "revision";

export interface EventoCorreo {
  tipo: TipoCorreo;
  orgId: string;
  // Ausente cuando el aviso es de un build que se descartó ANTES de existir: si el disparo agota
  // sus intentos, nunca se creó la automatización (la crea arrancarConstruccion), así que no hay
  // id que resolver ni detalle al que linkear. En ese caso el evento carga el `nombre` que venía
  // en la solicitud encolada.
  automatizacionId?: string;
  nombre?: string;
}

export interface Correo {
  asunto: string;
  texto: string; // versión de texto plano
  html: string; // versión HTML
}

/** Puerto: notifica un evento del ciclo. Impl real: Resend (wiring). El llamador lo usa
 *  best-effort (nunca falla el flujo si el correo no sale). */
export interface Notificador {
  notificar(evento: EventoCorreo): Promise<void>;
}

const escapar = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Plantilla PURA del correo por evento. `url` = link al portafolio/detalle (opcional). Español
 *  de México, tuteo, cero jerga (mismas convenciones que la UI). */
export function plantillaCorreo(tipo: TipoCorreo, ctx: { nombre: string; url?: string }): Correo {
  const nombre = ctx.nombre;
  const link = ctx.url;
  const cta = link ? `\n\nÁbrela aquí: ${link}` : "";
  const ctaHtml = link
    ? `<p style="margin-top:20px"><a href="${escapar(link)}" style="display:inline-block;background:#1D1710;color:#F4EEDF;padding:12px 22px;border-radius:9999px;text-decoration:none;font-weight:600">Abrir mi portafolio</a></p>`
    : "";
  const n = escapar(nombre);

  switch (tipo) {
    case "lista":
      return {
        asunto: `“${nombre}” ya está lista`,
        texto: `¡Buenas noticias! Tu automatización “${nombre}” quedó lista para usar. Entra a tu portafolio y ejecútala cuando quieras.${cta}`,
        html: `<h2 style="font-weight:800">“${n}” ya está lista 🎉</h2><p>Tu automatización quedó lista para usar. Entra a tu portafolio y ejecútala cuando quieras.</p>${ctaHtml}`,
      };
    case "fallo":
      return {
        asunto: `“${nombre}” necesita una revisión`,
        texto: `Tu automatización “${nombre}” no quedó a la primera. Nuestro equipo la revisa — no se te cobró — y te avisamos en cuanto esté.${cta}`,
        html: `<h2 style="font-weight:800">“${n}” necesita una revisión</h2><p>No quedó a la primera. Nuestro equipo la revisa — no se te cobró — y te avisamos en cuanto esté.</p>${ctaHtml}`,
      };
    case "revision":
      return {
        asunto: `“${nombre}”: revisamos un archivo`,
        texto: `Un archivo de “${nombre}” no lo pudimos leer bien, así que lo mandamos a revisión en vez de inventar datos. Te avisamos.${cta}`,
        html: `<h2 style="font-weight:800">“${n}”: revisamos un archivo</h2><p>Un archivo no lo pudimos leer bien, así que lo mandamos a revisión en vez de inventar datos. Te avisamos.</p>${ctaHtml}`,
      };
  }
}
