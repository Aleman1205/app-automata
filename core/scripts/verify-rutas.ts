// ─────────────────────────────────────────────────────────────────────────────
// Garantía ANTI-OLVIDO (adaptador-next.md §4 / docs/14 §2, BFLA/BOLA): escanea todos los
// web/app/api/**/route.ts y FALLA si algún verbo MUTANTE (POST/PUT/PATCH/DELETE) no resuelve
// a una ENTRADA SANCIONADA. Un route.ts que arme su propio handler con efecto se saltaría el
// rate-limit, authn, CSRF, la validación del orgId contra la membresía, assertCan y el step-up.
//   npm run verify:rutas
//
// ── Reescrito el 2026-07-31 tras la auditoría por mutación (AUDITORIA-SUITE.md, Parte 2) ──
// La versión anterior reconocía una FORMA SINTÁCTICA (`export const POST = ruta(...)`) con
// expresiones regulares sobre el archivo entero. Cinco mutaciones distintas la evadieron, y
// ninguna era rebuscada:
//
//   1. COMENTARIOS. El escáner leía el texto crudo, así que `// export const POST = ruta(ep);`
//      seguía satisfaciendo la regex. Comentar la línea vieja y escribir el handler nuevo
//      debajo —el refactor más común que existe— dejaba el endpoint sin las 8 capas, en verde.
//   2. `export { POST }`. La regex solo veía `export const|function`, así que un re-export
//      (o `export { h as POST }`) hacía DESAPARECER el verbo del escaneo entero. Y lo que no
//      se ve, no se comprueba: silencio, no fallo.
//   3. La exención de webhooks se daba por RUTA (estar bajo /webhooks/) y solo exigía NO usar
//      ruta(). Un POST propio bajo esa carpeta cumplía la condición sin verificar firma alguna
//      — y /webhooks/stripe es la fuente de verdad del plan de cada cliente.
//   4. Lo mismo con los crons: bajo /cron/ bastaba con no usar ruta(). Un POST sin CRON_SECRET
//      queda abierto a internet drenando la cola con el pool DUEÑO (~$1.8 por build).
//   5. `viaUpload` buscaba el nombre en TODO el archivo, no en el cuerpo del handler.
//
// El principio nuevo: cada verbo mutante se RESUELVE hasta su definición (con los comentarios
// fuera) y esa definición tiene que llamar a una entrada sancionada IMPORTADA DEL WIRING —
// no basta con que la palabra aparezca. Y la sanción es POSITIVA por clase de ruta: los
// webhooks deben delegar en el receptor que valida la firma HMAC, y los crons en el que
// comprueba CRON_SECRET. Antes se les pedía no hacer algo; ahora se les pide hacer lo correcto.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const API = join(AQUI, "..", "..", "web", "app", "api");
const MUTANTES = ["POST", "PUT", "PATCH", "DELETE"];
const WIRING = "@/lib/automata/wiring";

// Entradas sancionadas por clase de ruta. Todas viven en el wiring y todas terminan en
// `autorizar()` (las 8 capas), en la verificación de firma HMAC, o en el chequeo de CRON_SECRET.
// La lista es EXPLÍCITA a propósito: que añadir un camino nuevo obligue a pasar por aquí es
// justamente el punto de este verify.
const SANCIONADAS = {
  // Pipeline JSON: rate → authn → método → CSRF → org → membresía → assertCan → step-up.
  ruta: ["ruta"],
  // Mismas 8 capas por adaptarUpload: cuerpo binario/multipart, o necesidad del PoolClient y de
  // un puerto externo (Stripe) que ni Contexto ni Deps saben transportar.
  upload: ["subirEjemplo", "correrAutomatizacion", "crearCheckoutPago", "abrirPortalPago", "descargarResultado"],
  // Cuerpo crudo + firma HMAC: no pueden pasar por el pipeline JSON (que ya consumió el body).
  webhook: ["webhook", "webhookClerk"],
  // Auth por CRON_SECRET + pool DUEÑO: no hay sesión de usuario que autenticar.
  cron: ["cronAjustes", "cronCosecha", "cronDisparo", "cronReaper"],
} as const;

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

function rutasDe(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...rutasDe(p));
    else if (e === "route.ts" || e === "route.tsx") out.push(p);
  }
  return out;
}

/**
 * Quita comentarios respetando cadenas. Es la corrección #1 y no es cosmética: sin esto, una
 * línea COMENTADA sigue satisfaciendo cualquier regex y el escáner aprueba código que no existe.
 * Se hace con un recorrido de caracteres y no con regex porque `"https://…"` lleva `//` dentro
 * de una cadena, y borrar a partir de ahí mutilaría el archivo (y podría ocultar un handler).
 */
function sinComentarios(src: string): string {
  let out = "";
  let i = 0;
  let cadena: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];
    if (cadena) {
      if (c === "\\") { out += c + (src[i + 1] ?? ""); i += 2; continue; }
      if (c === cadena) cadena = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { cadena = c; out += c; i++; continue; }
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/** Identificadores importados desde el wiring. Un `ruta` definido en el propio archivo NO cuenta:
 *  si no, cualquiera declara `const ruta = (f) => f` y desactiva las 8 capas con el test en verde. */
function importadosDelWiring(src: string): Set<string> {
  const ids = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (m[2] !== WIRING) continue;
    for (const parte of m[1]!.split(",")) {
      const nombre = parte.trim().split(/\s+as\s+/).pop()?.trim();
      if (nombre) ids.add(nombre);
    }
  }
  return ids;
}

/**
 * Todos los verbos mutantes EXPORTADOS, en cualquiera de sus formas. La versión anterior solo
 * miraba `export const|function`, así que `export { POST }` volvía el verbo invisible — y un
 * verbo invisible no falla, simplemente no se comprueba.
 * Devuelve verbo → nombre del binding local que hay que resolver.
 */
function verbosExportados(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/export\s+(?:const|let|var|(?:async\s+)?function)\s+(\w+)/g)) {
    if (MUTANTES.includes(m[1]!)) out.set(m[1]!, m[1]!);
  }
  // `export { POST }`, `export { manejar as POST }`, `export { a, b as PUT }`
  for (const m of src.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const parte of m[1]!.split(",")) {
      const [orig, alias] = parte.split(/\s+as\s+/).map((s) => s.trim());
      const expuesto = alias ?? orig;
      if (expuesto && MUTANTES.includes(expuesto)) out.set(expuesto, orig || expuesto);
    }
  }
  // `export { POST } from "./otro"` — delega fuera del archivo: no se puede resolver aquí.
  for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
    for (const parte of m[1]!.split(",")) {
      const expuesto = (parte.split(/\s+as\s+/).pop() ?? "").trim();
      if (expuesto && MUTANTES.includes(expuesto)) out.set(expuesto, "\0reexport-externo");
    }
  }
  return out;
}

/** Texto de la definición de un binding: desde donde se declara hasta la siguiente declaración
 *  de nivel superior. Acotarlo importa: mirar el archivo entero fue el fallo #5 (un nombre
 *  sancionado en OTRO handler daba por bueno el de al lado). */
function definicionDe(src: string, nombre: string): string | null {
  const re = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:const|let|var|(?:async\\s+)?function)\\s+${nombre}\\b`);
  const m = re.exec(src);
  if (!m) return null;
  const desde = m.index;
  const resto = src.slice(desde + m[0].length);
  const corte = resto.search(/\n(?:export\s+)?(?:const|let|var|(?:async\s+)?function)\s+\w+/);
  return src.slice(desde, corte === -1 ? src.length : desde + m[0].length + corte);
}

/** ¿La definición llama (o referencia) a alguno de estos identificadores sancionados? */
function delegaEn(def: string, ids: readonly string[], delWiring: Set<string>): string | null {
  for (const id of ids) {
    if (!delWiring.has(id)) continue; // tiene que venir del wiring, no ser un homónimo local
    // `f(` cubre la llamada; `= f;` cubre el reexport directo (`export const POST = cronAjustes;`).
    if (new RegExp(`\\b${id}\\s*\\(`).test(def) || new RegExp(`=\\s*${id}\\s*;`).test(def)) return id;
  }
  return null;
}

/**
 * Alias LOCALES que valen tanto como la entrada sancionada a la que están ligados.
 * Existe por un patrón real y legítimo: `/miembros` hace `const invitar = ruta(invitarEP)` y
 * exporta un `POST` que lo llama, porque necesita un efecto POSTERIOR al endpoint (mandar el
 * correo de invitación) sin abrir un segundo camino de escritura.
 * Se resuelve a punto fijo por si algún día hay dos saltos, y el alias solo cuenta si la cadena
 * termina en un identificador IMPORTADO DEL WIRING: `const invitar = miRuta(ep)` con un `miRuta`
 * casero no sanciona nada.
 */
function aliasSancionados(src: string, ids: readonly string[], delWiring: Set<string>): string[] {
  const validos = new Set<string>(ids.filter((i) => delWiring.has(i)));
  let creció = true;
  while (creció) {
    creció = false;
    for (const m of src.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+(\w+)\s*=\s*(\w+)\s*\(/g)) {
      const [, alias, llamado] = m;
      if (alias && llamado && validos.has(llamado) && !validos.has(alias)) { validos.add(alias); creció = true; }
    }
  }
  return [...validos];
}

// ─────────────────────────────────────────────────────────────────────────────
// El escáner también se prueba a SÍ MISMO. Un detector que no ve una forma no falla: calla —
// y ese silencio fue la mutación #2 de la auditoría. Estos fixtures obligan a que reconocer
// menos formas rompa el test, no que lo relaje.
// ─────────────────────────────────────────────────────────────────────────────
function autoprueba() {
  console.log("1. El detector reconoce las formas de export (si deja de verlas, calla en vez de fallar):");
  const casos: [string, string, boolean][] = [
    ["export const POST = ruta(ep);", "const directo", true],
    ["export async function POST(r) {}", "function async", true],
    ["function manejar(r) {}\nexport { manejar as POST };", "export {x as POST}", true],
    ["const POST = ruta(ep);\nexport { POST };", "export {POST}", true],
    ["export const GET = ruta(ep);", "GET no es mutante", false],
  ];
  for (const [src, nombre, esperado] of casos) {
    check(`ve ${nombre}`, verbosExportados(src).has("POST") === esperado);
  }
  console.log("\n2. Los comentarios NO cuentan como código (el refactor 'comento y escribo debajo'):");
  const comentado = sinComentarios('// export const POST = ruta(ep);\nexport async function POST(r) { return new Response("//x"); }');
  check("una línea comentada desaparece del análisis", !/ruta\(/.test(comentado));
  check("un '//' dentro de una cadena NO mutila el archivo", /return new Response/.test(comentado));
  check("un bloque /* */ desaparece", !/oculto/.test(sinComentarios("/* oculto */ const x = 1;")));
  console.log("\n3. Una entrada sancionada tiene que venir del WIRING, no ser un homónimo local:");
  const falsa = "const ruta = (f) => f;\nexport const POST = ruta(ep);";
  check("un `ruta` definido en el archivo no vale", delegaEn(falsa, SANCIONADAS.ruta, importadosDelWiring(falsa)) === null);
  const buena = `import { ruta } from "${WIRING}";\nexport const POST = ruta(ep);`;
  check("un `ruta` importado del wiring sí vale", delegaEn(buena, SANCIONADAS.ruta, importadosDelWiring(buena)) === "ruta");

  console.log("\n3bis. El patrón ENVUELTO sigue valiendo, pero solo si la cadena llega a ruta():");
  // Es el caso REAL de /miembros: `const invitar = ruta(ep)` + un POST que lo llama para poder
  // mandar el correo DESPUÉS del endpoint. Si esto dejara de reconocerse, el arreglo de este
  // verify rompería código correcto — que es la otra forma de fallar, no menos cara.
  const env = `import { ruta } from "${WIRING}";\nconst invitar = ruta(ep);\nexport async function POST(r) { return invitar(r); }`;
  check("alias ligado a ruta() sanciona el handler", aliasSancionados(env, SANCIONADAS.ruta, importadosDelWiring(env)).includes("invitar"));
  const casero = `const miRuta = (f) => f;\nconst invitar = miRuta(ep);\nexport async function POST(r) { return invitar(r); }`;
  check("alias ligado a un envoltorio CASERO no sanciona nada", !aliasSancionados(casero, SANCIONADAS.ruta, importadosDelWiring(casero)).includes("invitar"));
}

function main() {
  autoprueba();

  console.log("\n4. Todo verbo mutante de web/app/api resuelve a una entrada sancionada:");
  if (!existsSync(API)) return check(`existe web/app/api (${API})`, false), finalizar();

  const archivos = rutasDe(API);
  check("hay al menos un route.ts que escanear", archivos.length > 0);

  let mutantesVistos = 0;
  for (const f of archivos) {
    const rel = relative(API, f);
    const src = sinComentarios(readFileSync(f, "utf8"));
    const delWiring = importadosDelWiring(src);
    const esWebhook = /(^|\/)webhooks?(\/|$)/.test(rel);
    const esCron = /(^|\/)cron(\/|$)/.test(rel);

    for (const [verbo, binding] of verbosExportados(src)) {
      mutantesVistos++;
      if (binding === "\0reexport-externo") {
        // Un route.ts que reexporta el handler de otro archivo saca el efecto del alcance de
        // este escáner. Se rechaza de frente en vez de aprobarlo por no poder verlo.
        check(`${rel}: ${verbo} NO se reexporta desde otro archivo (queda fuera de auditoría)`, false);
        continue;
      }
      const def = definicionDe(src, binding);
      if (def === null) {
        check(`${rel}: ${verbo} tiene una definición localizable`, false);
        continue;
      }

      if (esWebhook) {
        // POSITIVO: tiene que delegar en el receptor que valida la firma HMAC. Antes solo se le
        // pedía NO usar ruta(), y un POST propio cumplía eso sin verificar nada.
        const via = delegaEn(def, SANCIONADAS.webhook, delWiring);
        check(`${rel}: ${verbo} delega en el receptor con firma HMAC (${via ?? "NINGUNO"})`, via !== null);
        check(`${rel}: ${verbo} no pasa por ruta() (el pipeline ya consumiría el cuerpo crudo)`,
          delegaEn(def, SANCIONADAS.ruta, delWiring) === null);
        continue;
      }
      if (esCron) {
        // POSITIVO: tiene que delegar en el cron del wiring, que es quien compara CRON_SECRET.
        const via = delegaEn(def, SANCIONADAS.cron, delWiring);
        check(`${rel}: ${verbo} delega en el cron que exige CRON_SECRET (${via ?? "NINGUNO"})`, via !== null);
        continue;
      }
      // Los alias locales ligados a ruta() valen igual (el patrón «envuelto» de /miembros).
      const conAlias = aliasSancionados(src, SANCIONADAS.ruta, delWiring);
      const via = delegaEn(def, conAlias, new Set(conAlias)) ?? delegaEn(def, SANCIONADAS.upload, delWiring);
      check(`${rel}: ${verbo} → ${via ?? "NINGUNA ENTRADA SANCIONADA"}`, via !== null);
    }
  }
  // Si un cambio rompe el detector y deja de ver verbos, esto lo caza: el silencio deja de ser
  // aprobación. El número es un piso deliberadamente holgado, no un conteo exacto que estorbe.
  check(`el escáner ve verbos mutantes (${mutantesVistos}, se esperan ≥10)`, mutantesVistos >= 10);
  finalizar();
}

function finalizar() {
  console.log(`\n${ok ? "✓ RUTAS PROBADAS" : "✗ FALLÓ"} — cada verbo mutante resuelve a una entrada sancionada del wiring.`);
  process.exit(ok ? 0 : 1);
}

main();
