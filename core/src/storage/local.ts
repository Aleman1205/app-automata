import { promises as fs } from "node:fs";
import path from "node:path";
import type { Storage } from "../types.ts";

// Storage en filesystem local (M0). La forma es idéntica a un blob store por
// clave, así que en producción se cambia por R2/S3 sin tocar a los llamadores.
export class LocalStorage implements Storage {
  constructor(private raiz: string) {}

  private ruta(key: string): string {
    // Evita path traversal: la clave nunca sale de la raíz.
    const destino = path.resolve(this.raiz, key);
    if (!destino.startsWith(path.resolve(this.raiz) + path.sep)) {
      throw new Error(`Clave fuera de la raíz de storage: ${key}`);
    }
    return destino;
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    const destino = this.ruta(key);
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.writeFile(destino, data);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.ruta(key));
  }

  async getText(key: string): Promise<string> {
    return fs.readFile(this.ruta(key), "utf8");
  }

  async list(prefix: string): Promise<string[]> {
    const base = this.ruta(prefix);
    try {
      const entradas = await fs.readdir(base);
      return entradas.map((e) => path.posix.join(prefix, e));
    } catch {
      return [];
    }
  }
}
