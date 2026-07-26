import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { Storage } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Storage en Cloudflare R2 (S3-compatible). Reemplaza a LocalStorage en producción
// sin tocar a los llamadores: implementa el MISMO puerto `Storage`.
//
// El cliente S3 se INYECTA (no se construye aquí) para dos cosas: (1) el test lo
// sustituye por un doble que no toca la red; (2) el cableado (web/) decide cuándo
// crearlo (lazy, tras leer env). `crearClienteR2` arma el cliente real desde la
// config de R2.
//
// Seguridad: en S3 las claves son PLANAS (un "/" es literal, no hay traversal de
// filesystem como en LocalStorage). Aun así, el llamador SIEMPRE deriva la clave de
// datos ya acotados por RLS (p.ej. `artefactos/<versionId>.json`, con versionId UUID
// inadivinable), nunca de entrada del cliente. Este adaptador no re-valida la clave:
// su trabajo es hablar S3, no autorizar.
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfigR2 {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Cliente S3 apuntando al endpoint de R2 de la cuenta. `region: "auto"` es lo que
 *  R2 espera; el endpoint lleva el accountId. */
export function crearClienteR2(cfg: ConfigR2): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // R2 no soporta el checksum de integridad por-request que el SDK v3 añade por
    // defecto en algunas rutas; forzarlo solo cuando el usuario lo pida evita 501s.
    forcePathStyle: false,
  });
}

/** Interfaz mínima que el adaptador necesita del cliente S3. Permite inyectar un
 *  doble en el test sin arrastrar todo `S3Client`. `S3Client` la satisface. */
export interface ClienteS3 {
  send(command: unknown): Promise<unknown>;
}

export class R2Storage implements Storage {
  constructor(private client: ClienteS3, private bucket: string) {}

  async put(key: string, data: Buffer | string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }));
  }

  async get(key: string): Promise<Buffer> {
    const r = (await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!r.Body) throw new Error(`R2: objeto sin cuerpo: ${key}`);
    return Buffer.from(await r.Body.transformToByteArray());
  }

  async getText(key: string): Promise<string> {
    const r = (await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as { Body?: { transformToString(enc?: string): Promise<string> } };
    if (!r.Body) throw new Error(`R2: objeto sin cuerpo: ${key}`);
    return r.Body.transformToString("utf-8");
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    // Paginar: S3/R2 devuelve como mucho 1000 claves por página. Sin esto, un prefijo
    // con >1000 objetos se truncaría en silencio.
    do {
      const r = (await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      )) as {
        Contents?: Array<{ Key?: string }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const o of r.Contents ?? []) if (o.Key) out.push(o.Key);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  /** ¿Existe el objeto? HEAD (sin descargar el cuerpo). NO es parte del puerto
   *  `Storage`: es específico de R2, para el guard de "no marcar 'lista' si los bytes
   *  no subieron" (follow-up del data plane). Un 404/NotFound → false; otros errores
   *  (permisos, red) se propagan — no los tragamos como "no existe". */
  async existe(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === "NotFound" || err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
        return false;
      }
      throw e;
    }
  }
}
