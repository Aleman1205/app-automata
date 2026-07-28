// ─────────────────────────────────────────────────────────────────────────────
// Verificación de las PLANTILLAS de correo (puras, sin llaves ni BD): cada evento del ciclo
// produce un asunto + texto + HTML con el nombre de la automatización, sin jerga, y el link
// cuando se pasa. Escapa HTML del nombre (anti-inyección en el correo). El envío real (Resend)
// vive en el wiring y se prueba con la llave del usuario.
//   npm run verify:notificaciones
// ─────────────────────────────────────────────────────────────────────────────
import { plantillaCorreo, type TipoCorreo } from "../src/ops/notificaciones.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

const URL = "https://automata.mx/portafolio/abc";

console.log("1. Cada evento produce un correo con el nombre y el link:");
for (const tipo of ["lista", "fallo", "revision"] as TipoCorreo[]) {
  const c = plantillaCorreo(tipo, { nombre: "Reporte de ventas", url: URL });
  check(`${tipo}: asunto menciona la automatización`, c.asunto.includes("Reporte de ventas"));
  check(`${tipo}: texto y html no vacíos`, c.texto.length > 20 && c.html.length > 20);
  check(`${tipo}: incluye el link cuando se pasa url`, c.texto.includes(URL) && c.html.includes(URL));
}

console.log("\n2. 'lista' es positivo; 'fallo' aclara que no se cobró:");
const lista = plantillaCorreo("lista", { nombre: "X" });
const fallo = plantillaCorreo("fallo", { nombre: "X" });
check("lista dice 'lista'", /lista/i.test(lista.asunto));
check("fallo dice 'revisión' y 'no se te cobró'", /revisi/i.test(fallo.asunto) && /no se te cobr/i.test(fallo.texto));

console.log("\n3. Escapa HTML del nombre (anti-inyección en el correo):");
const malicioso = plantillaCorreo("lista", { nombre: "<script>alert(1)</script>" });
check("el <script> del nombre va escapado en el HTML", !malicioso.html.includes("<script>") && malicioso.html.includes("&lt;script&gt;"));

console.log("\n4. Sin url, no rompe (no mete link roto):");
const sinUrl = plantillaCorreo("lista", { nombre: "X" });
check("sin url el texto no trae 'Ábrela aquí:'", !sinUrl.texto.includes("Ábrela aquí"));

console.log(`\n${ok ? "✓ PLANTILLAS DE CORREO PROBADAS" : "✗ FALLÓ"} — asunto/texto/html por evento, escape de HTML, link opcional.`);
process.exit(ok ? 0 : 1);
