// ─────────────────────────────────────────────────────────────────────────────
// Verificación del adaptador R2Storage SIN tocar la red: se inyecta un doble del
// cliente S3 (un `send` que despacha por tipo de comando contra un Map en memoria).
// Prueba que el adaptador (1) usa los comandos correctos, (2) maneja las claves y los
// cuerpos bien, (3) PAGINA en list (>1000 claves no se truncan), (4) `existe` distingue
// 404 de error real. El cliente real de R2 se prueba con credenciales, aparte.
//   npm run verify:storage
// ─────────────────────────────────────────────────────────────────────────────
import { R2Storage, type ClienteS3 } from "../src/storage/r2.ts";

let ok = true;
const check = (n: string, p: boolean) => { console.log(`  ${p ? "✓" : "✗"} ${n}`); ok = ok && p; };

// Doble del cliente S3: reproduce lo justo del protocolo (Put/Get/Head/List) contra
// un Map, incluida la PAGINACIÓN de ListObjectsV2 (páginas de `pageSize`).
class S3Falso implements ClienteS3 {
  m = new Map<string, Buffer>();
  pageSize: number;
  comandos: string[] = [];
  constructor(pageSize = 1000) { this.pageSize = pageSize; }

  async send(command: unknown): Promise<unknown> {
    const cmd = command as { constructor: { name: string }; input: Record<string, unknown> };
    const name = cmd.constructor.name;
    const inp = cmd.input;
    this.comandos.push(name);
    if (name === "PutObjectCommand") {
      const body = inp["Body"];
      this.m.set(inp["Key"] as string, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
      return {};
    }
    if (name === "GetObjectCommand") {
      const b = this.m.get(inp["Key"] as string);
      if (!b) { const e = new Error("NoSuchKey") as Error & { name: string }; e.name = "NoSuchKey"; throw e; }
      return {
        Body: {
          transformToByteArray: async () => new Uint8Array(b),
          transformToString: async () => b.toString("utf8"),
        },
      };
    }
    if (name === "HeadObjectCommand") {
      if (this.m.has(inp["Key"] as string)) return { ContentLength: this.m.get(inp["Key"] as string)!.length };
      const e = new Error("NotFound") as Error & { name: string; $metadata: { httpStatusCode: number } };
      e.name = "NotFound"; e.$metadata = { httpStatusCode: 404 };
      throw e;
    }
    if (name === "ListObjectsV2Command") {
      const prefix = (inp["Prefix"] as string) ?? "";
      const token = inp["ContinuationToken"] as string | undefined;
      const todas = [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
      const desde = token ? Number(token) : 0;
      const pagina = todas.slice(desde, desde + this.pageSize);
      const fin = desde + this.pageSize;
      const truncada = fin < todas.length;
      return {
        Contents: pagina.map((Key) => ({ Key })),
        IsTruncated: truncada,
        NextContinuationToken: truncada ? String(fin) : undefined,
      };
    }
    throw new Error(`comando no soportado por el doble: ${name}`);
  }
}

async function main() {
  console.log("R2Storage contra un doble del cliente S3 (sin red):\n");

  // 1. put/getText round-trip (string) + get (Buffer)
  const falso = new S3Falso();
  const s = new R2Storage(falso, "bucket-x");
  await s.put("artefactos/v1.json", '{"hola":"mundo"}');
  check("getText devuelve exactamente lo que se puso", (await s.getText("artefactos/v1.json")) === '{"hola":"mundo"}');
  const buf = await s.get("artefactos/v1.json");
  check("get devuelve un Buffer con los mismos bytes", Buffer.isBuffer(buf) && buf.toString("utf8") === '{"hola":"mundo"}');
  check("put usó PutObjectCommand y get usó GetObjectCommand", falso.comandos.includes("PutObjectCommand") && falso.comandos.includes("GetObjectCommand"));

  // 2. put con Buffer binario (no solo texto)
  const bin = Buffer.from([0, 1, 2, 253, 254, 255]);
  await s.put("blobs/b.bin", bin);
  check("un Buffer binario sobrevive el round-trip byte a byte", (await s.get("blobs/b.bin")).equals(bin));

  // 3. get de clave inexistente propaga (NO devuelve vacío)
  check("get de clave inexistente lanza (no enmascara el 404)", await s.getText("no/existe").then(() => false).catch(() => true));

  // 4. existe: HEAD, distingue presente/ausente
  check("existe(presente) → true", (await s.existe("artefactos/v1.json")) === true);
  check("existe(ausente) → false (404 se traduce a false)", (await s.existe("no/existe")) === false);
  check("existe usó HeadObjectCommand (no descarga el cuerpo)", falso.comandos.includes("HeadObjectCommand"));

  // 5. existe propaga errores que NO son 404 (permisos/red) — no los traga como false
  const s403 = new R2Storage(
    { async send() { const e = new Error("AccessDenied") as Error & { name: string; $metadata: { httpStatusCode: number } }; e.name = "AccessDenied"; e.$metadata = { httpStatusCode: 403 }; throw e; } },
    "b",
  );
  check("existe con 403 PROPAGA (no lo confunde con 'no existe')", await s403.existe("x").then(() => false).catch(() => true));

  // 6. list PAGINA: 2500 claves con páginas de 1000 → 3 páginas, 0 truncamiento
  const grande = new S3Falso(1000);
  const sg = new R2Storage(grande, "b");
  for (let i = 0; i < 2500; i++) await sg.put(`lote/${String(i).padStart(4, "0")}.json`, "x");
  grande.comandos.length = 0; // resetea el contador para medir SOLO el list
  const claves = await sg.list("lote/");
  check("list devuelve las 2500 claves (no se trunca en 1000)", claves.length === 2500);
  check("list paginó (3 llamadas a ListObjectsV2Command para 2500/1000)", grande.comandos.filter((c) => c === "ListObjectsV2Command").length === 3);
  check("list respeta el prefijo (no trae 'artefactos/…')", claves.every((k) => k.startsWith("lote/")));

  // 7. list de prefijo vacío → []
  check("list de prefijo sin objetos → [] (no lanza)", (await sg.list("vacio/")).length === 0);

  console.log(`\n${ok ? "✓ R2Storage PROBADO" : "✗ FALLÓ"} — mismo puerto que LocalStorage, comandos S3 correctos, list pagina, existe distingue 404 de error real.`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("Error:", e); process.exit(1); });
