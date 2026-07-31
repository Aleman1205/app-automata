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

export type TipoCorreo = "lista" | "fallo" | "revision" | "invitacion";

export interface EventoCorreo {
  tipo: TipoCorreo;
  orgId: string;
  // SOLO para 'invitacion': a quién se le escribe. Es el único aviso cuyo destinatario NO son los
  // admins de la org — es alguien que todavía no tiene cuenta, así que no hay a quién resolver por
  // Clerk. Sin esto la invitación le llegaría a quien invita, no al invitado.
  destinatario?: string;
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
  // El botón NO puede decir siempre "Abrir mi portafolio": en la invitación quien lee todavía no
  // tiene portafolio (ni cuenta), y mandarlo ahí lo estrella contra el default-deny del middleware.
  const invita = tipo === "invitacion";
  const etiquetaCta = invita ? "Entrar al equipo" : "Abrir mi portafolio";
  const cta = link ? (invita ? `\n\nEntra aquí: ${link}` : `\n\nÁbrela aquí: ${link}`) : "";
  const ctaHtml = link
    ? `<p style="margin-top:20px"><a href="${escapar(link)}" style="display:inline-block;background:#1D1710;color:#F4EEDF;padding:12px 22px;border-radius:9999px;text-decoration:none;font-weight:600">${etiquetaCta}</a></p>`
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
    // Aquí `nombre` es el del NEGOCIO que invita, no el de una automatización: es el único correo
    // que no habla de una automatización. Y NO se nombra a quien invitó ni se promete nada del
    // plan: el remitente es la app, no una persona, y el correo llega a alguien que quizá no nos
    // conoce. Se le dice quién lo invitó (la empresa), qué es esto y qué hacer.
    case "invitacion":
      return {
        asunto: `Te invitaron a ${nombre} en Automata`,
        texto: `Te invitaron a trabajar en “${nombre}” dentro de Automata, donde el equipo automatiza tareas repetitivas (reportes, conciliaciones) sin programar.\n\nPara entrar, regístrate con ESTE mismo correo — es con el que te invitaron.${cta}\n\nSi no esperabas esta invitación, ignora este mensaje: no se creó ninguna cuenta a tu nombre.`,
        html: `<h2 style="font-weight:800">Te invitaron a ${n}</h2><p>Te invitaron a trabajar en “${n}” dentro de Automata, donde el equipo automatiza tareas repetitivas (reportes, conciliaciones) sin programar.</p><p>Para entrar, regístrate con <strong>este mismo correo</strong> — es con el que te invitaron.</p>${ctaHtml}<p style="margin-top:24px;font-size:13px;color:#6B5D4A">Si no esperabas esta invitación, ignora este mensaje: no se creó ninguna cuenta a tu nombre.</p>`,
      };
    case "revision":
      return {
        asunto: `“${nombre}”: revisamos un archivo`,
        texto: `Un archivo de “${nombre}” no lo pudimos leer bien, así que lo mandamos a revisión en vez de inventar datos. Te avisamos.${cta}`,
        html: `<h2 style="font-weight:800">“${n}”: revisamos un archivo</h2><p>Un archivo no lo pudimos leer bien, así que lo mandamos a revisión en vez de inventar datos. Te avisamos.</p>${ctaHtml}`,
      };
  }
}
