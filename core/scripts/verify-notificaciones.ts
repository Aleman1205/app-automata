// ─────────────────────────────────────────────────────────────────────────────
// Verificación de las PLANTILLAS de correo (puras, sin llaves ni BD): cada evento del ciclo
// produce un asunto + texto + HTML con el nombre de la automatización, sin jerga, y el link
// cuando se pasa. Escapa HTML del nombre (anti-inyección en el correo). El envío real (Resend)
// vive en el wiring y se prueba con la llave del usuario.
//   npm run verify:notificaciones
// ─────────────────────────────────────────────────────────────────────────────
import { plantillaCorreo, type TipoCorreo } from "../src/ops/notificaciones.ts";
import { MARCA, DOMINIO } from "../src/marca.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

const URL = `https://${DOMINIO}/portafolio/abc`;

// Exhaustivo POR TIPOS, no una lista a mano: el Record obliga a que agregar un TipoCorreo NO
// compile hasta listarlo aquí. Antes eran tres strings sueltos y 'invitacion' se coló sin una sola
// prueba — la suite seguía en verde ignorándolo.
const TODOS: Record<TipoCorreo, true> = { lista: true, fallo: true, revision: true, invitacion: true };

console.log("1. Cada evento produce un correo con el nombre y el link:");
for (const tipo of Object.keys(TODOS) as TipoCorreo[]) {
  const c = plantillaCorreo(tipo, { nombre: "Reporte de ventas", url: URL });
  check(`${tipo}: asunto menciona de qué se trata`, c.asunto.includes("Reporte de ventas"));
  check(`${tipo}: texto y html no vacíos`, c.texto.length > 20 && c.html.length > 20);
  check(`${tipo}: incluye el link cuando se pasa url`, c.texto.includes(URL) && c.html.includes(URL));
}

console.log("\n2. 'lista' es positivo; 'fallo' aclara que no se cobró:");
const lista = plantillaCorreo("lista", { nombre: "X" });
const fallo = plantillaCorreo("fallo", { nombre: "X" });
check("lista dice 'lista'", /lista/i.test(lista.asunto));
check("fallo dice 'revisión' y 'no se te cobró'", /revisi/i.test(fallo.asunto) && /no se te cobr/i.test(fallo.texto));

console.log("\n2bis. La invitación le habla a alguien que AÚN NO es cliente:");
const invi = plantillaCorreo("invitacion", { nombre: "Hotel Vitrales", url: `https://${DOMINIO}/registrarse` });
check("el asunto dice quién lo invita", invi.asunto.includes("Hotel Vitrales"));
// Le pide registrarse con ESE correo porque la invitación vive en la tabla `invitaciones` indexada
// por correo: si se registra con otro, no entra al equipo y el lugar del plan se queda ocupado.
check("le pide usar el MISMO correo (si usa otro, no entra al equipo)", /este mismo correo/i.test(invi.texto));
// Llega a alguien que quizá no nos conoce: sin salida explícita, un correo así se lee como spam.
check("da salida a quien no la esperaba", /ignora este mensaje/i.test(invi.texto));
check("aclara que no se creó cuenta a su nombre", /no se creó ninguna cuenta/i.test(invi.texto));
// El botón NO puede decir "Abrir mi portafolio": quien lee no tiene cuenta y el middleware
// (default-deny de páginas) lo rebotaría a login.
check("el botón lleva a registrarse, no al portafolio", invi.html.includes("Entrar al equipo") && !invi.html.includes("Abrir mi portafolio"));
// La invitación es el ÚNICO correo que nombra a la EMPRESA (los demás hablan de la automatización
// del cliente, que ya sabe quiénes somos). Aquí llega a alguien que quizá no nos conoce: sin el
// nombre, el correo dice "te invitaron a Hotel Vitrales" y nadie entiende de dónde salió.
// Se contrasta contra la constante MARCA, no contra un literal: así, si alguien vuelve a
// hardcodear el nombre aquí, renombrar la empresa TUMBA este test en vez de mandar correos con el
// nombre viejo — que es exactamente lo que pasaba antes de que MARCA viviera en el core.
check("la invitación nombra a la empresa en asunto, texto y HTML",
  invi.asunto.includes(MARCA) && invi.texto.includes(MARCA) && invi.html.includes(MARCA));

console.log("\n3. Escapa HTML del nombre (anti-inyección en el correo):");
const malicioso = plantillaCorreo("lista", { nombre: "<script>alert(1)</script>" });
check("el <script> del nombre va escapado en el HTML", !malicioso.html.includes("<script>") && malicioso.html.includes("&lt;script&gt;"));
// El nombre de la org lo escribe un CLIENTE (y hoy no hay endpoint para renombrarla, pero lo
// habrá): si no se escapa, ese cliente redacta HTML dentro de un correo que mandamos NOSOTROS a
// terceros que ni siquiera son sus usuarios.
const orgMaliciosa = plantillaCorreo("invitacion", { nombre: '<a href="http://malo.mx">Cobra aquí</a>' });
check("la invitación también escapa el nombre de la org (lo escribe un cliente)",
  !orgMaliciosa.html.includes("<a href=\"http://malo.mx\">") && orgMaliciosa.html.includes("&lt;a href="));

console.log("\n4. Sin url, no rompe (no mete link roto):");
const sinUrl = plantillaCorreo("lista", { nombre: "X" });
check("sin url el texto no trae 'Ábrela aquí:'", !sinUrl.texto.includes("Ábrela aquí"));

console.log(`\n${ok ? "✓ PLANTILLAS DE CORREO PROBADAS" : "✗ FALLÓ"} — asunto/texto/html por evento, escape de HTML, link opcional.`);
process.exit(ok ? 0 : 1);
