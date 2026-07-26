// ─────────────────────────────────────────────────────────────────────────────
// Garantía ANTI-OLVIDO (adaptador-next.md §4 / docs/14 §2, BFLA/BOLA): escanea todos los
// web/app/api/**/route.ts y FALLA si algún verbo MUTANTE (POST/PUT/PATCH/DELETE) no pasa
// por `ruta()` — el único camino sancionado, que aplica withEfecto (rate/authn/CSRF/rol/
// step-up/validación). Un route.ts que arme su propio handler con efecto (sin `ruta`) se
// saltaría todas esas capas; este test lo caza en CI. Los webhooks van por OTRO camino
// (cuerpo crudo + firma HMAC), así que se excluyen.
//   npm run verify:rutas
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const API = join(AQUI, "..", "..", "web", "app", "api");
const MUTANTES = ["POST", "PUT", "PATCH", "DELETE"];

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

function main() {
  console.log("Anti-olvido: todo verbo mutante de web/app/api pasa por ruta():");
  if (!existsSync(API)) {
    check(`existe web/app/api (${API})`, false);
    return finalizar();
  }
  const archivos = rutasDe(API);
  check("hay al menos un route.ts que escanear", archivos.length > 0);

  for (const f of archivos) {
    const rel = relative(API, f);
    const src = readFileSync(f, "utf8");
    const esWebhook = /(^|\/)webhooks?(\/|$)/.test(rel);
    for (const m of MUTANTES) {
      const exporta = new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${m}\\b`).test(src);
      if (!exporta) continue;
      if (esWebhook) {
        // Webhooks NO usan ruta (cuerpo crudo + firma); solo se exige que NO la usen aquí.
        check(`${rel}: ${m} (webhook) NO usa ruta() — va por firma HMAC`, !new RegExp(`${m}\\s*=\\s*ruta`).test(src));
        continue;
      }
      const viaRuta = new RegExp(`export\\s+const\\s+${m}\\s*=\\s*ruta\\s*\\(`).test(src);
      check(`${rel}: ${m} pasa por ruta() (con efecto → withEfecto)`, viaRuta);
    }
  }
  finalizar();
}

function finalizar() {
  console.log(`\n${ok ? "✓ RUTAS PROBADAS" : "✗ FALLÓ"} — ningún handler con efecto se salta withEfecto.`);
  process.exit(ok ? 0 : 1);
}

main();
