import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Pool } from "pg";
import { conOrg } from "../db/pg.ts";
import { iniciarAjuste, fallarAjuste } from "../ciclo/servicio.ts";
import { PgStateRepo } from "../state/pg.ts";
import type { Artefacto, BuildClientAsync, PeticionAjuste, Spec, Storage } from "../types.ts";
import type { ResultadoRegresion, TipoAjuste } from "../ciclo/estados.ts";
import { artefactoKey } from "./build-pipeline.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Arranque de un build de AJUSTE (la pieza que faltaba del ciclo de vida).
//
// El ciclo ya sabía RESERVAR (iniciarAjuste crea la versión 'building', deriva el tipo de la
// regresión y deja que la BD cobre) y CONFIRMAR (confirmarAjuste, que ya llama el drainer de
// cosecha). Lo que NO existía era el pedazo de en medio: NADIE abría una sesión de CMA para una
// versión > 1. arrancarConstruccion no sirve — crea una automatización NUEVA y clava `numero: 1`,
// así que un ajuste habría quedado como una automatización duplicada. Sin este módulo, exponer el
// ajuste por HTTP habría cobrado la generación del cliente y dejado una versión 'building' que
// nadie arranca, muerta hasta que el reaper la marque 'failed' 6 h después.
//
// Orden deliberado (mismo patrón que arrancarConstruccion: reservar antes de gastar):
//   1. tx corta: iniciarAjuste → versión 'building' + tipo persistido. La tx se CIERRA aquí; la
//      llamada a CMA (segundos) no retiene una conexión ni un FOR UPDATE.
//   2. baja el artefacto vigente del storage (best-effort) para que el agente MODIFIQUE en vez de
//      reinventar; baja el ejemplo original, que CMA necesita para probar.
//   3. arranca la sesión y graba su id (write-once). Desde ahí el loop existente cierra solo:
//      webhook → cosecha → confirmarAjuste.
//   4. si el arranque falla, marca la versión 'failed' (fallarAjuste) para no dejar el "un build en
//      vuelo" trabado: sin eso, la automatización quedaría sin poder pedir otro ajuste nunca.
// ─────────────────────────────────────────────────────────────────────────────

export interface AjusteDeps {
  pool: Pool; // pool de APP (el ciclo corre bajo RLS por conOrg)
  cosechador: BuildClientAsync;
  storage: Storage;
  ahora: () => string;
}

export interface AjusteArgs {
  orgId: string;
  automatizacionId: string;
  peticion: string; // lo que el cliente escribió
  spec: Spec; // el spec vigente de la automatización
  ejemploKey: string; // el ejemplo con el que se construyó (CMA lo necesita para probar)
  regresion: ResultadoRegresion; // "falla" → reparación gratis; "pasa"/"indeterminado" → cambio
  contratoTexto?: string;
}

export interface AjusteArrancado {
  tipo: TipoAjuste;
  versionId: string;
  numero: number;
  sessionId: string;
}

/** El código de la versión vigente, para dárselo al agente. Best-effort: si no se puede recuperar
 *  (artefacto ausente, JSON raro), el build sigue sin él y el prompt lo dice explícitamente en vez
 *  de fingir que lo tiene. */
async function codigoVigente(storage: Storage, versionId: string): Promise<string | undefined> {
  try {
    const artefacto = JSON.parse(await storage.getText(artefactoKey(versionId))) as Artefacto;
    return artefacto.automatizacionPy;
  } catch {
    return undefined;
  }
}

/** Arranca el build de un ajuste sobre una automatización que YA existe. Lanza lo que lance el
 *  ciclo (AjusteNoPermitido / AjusteEnCurso / AutomatizacionNoDisponible / CuotaExcedida /
 *  ServicioSuspendido): el llamador los traduce a mensajes de cliente. */
export async function arrancarAjuste(deps: AjusteDeps, args: AjusteArgs): Promise<AjusteArrancado> {
  // 1. RESERVA en una tx corta. iniciarAjuste valida guardas (activa, sin build en vuelo, ajustes
  //    disponibles si es cambio) y persiste el tipo; la BD cobra la generación si es cambio.
  const iniciado = await conOrg(deps.pool, args.orgId, (c) =>
    iniciarAjuste(c, args.automatizacionId, args.regresion),
  );

  try {
    // 2. Insumos del build: el ejemplo original (CMA prueba con él) y el código vigente.
    const versionVigente = await conOrg(deps.pool, args.orgId, async (c) => {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM versiones WHERE automatizacion_id = $1 AND estado = 'lista'
           ORDER BY numero DESC LIMIT 1`,
        [args.automatizacionId],
      );
      return r.rows[0]?.id;
    });
    const codigoAnterior = versionVigente ? await codigoVigente(deps.storage, versionVigente) : undefined;

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ajuste-"));
    try {
      const ejemploPath = path.join(dir, path.basename(args.ejemploKey));
      await fs.writeFile(ejemploPath, await deps.storage.get(args.ejemploKey));
      const ajuste: PeticionAjuste = {
        peticion: args.peticion,
        codigoAnterior,
        numeroVersion: iniciado.numero,
      };
      // 3. Arranca CMA y graba la sesión (write-once). El webhook + la cosecha cierran el ciclo.
      const { sessionId } = await deps.cosechador.arrancar(args.spec, ejemploPath, args.contratoTexto, ajuste);
      await new PgStateRepo(deps.pool, args.orgId).fijarSesionCma(iniciado.versionId, sessionId);
      return { tipo: iniciado.tipo, versionId: iniciado.versionId, numero: iniciado.numero, sessionId };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (e) {
    // 4. Sin esto la versión se queda 'building' y el guard de "un build en vuelo" bloquea CUALQUIER
    //    ajuste futuro hasta que el reaper la limpie horas después.
    await conOrg(deps.pool, args.orgId, (c) => fallarAjuste(c, args.automatizacionId, iniciado.versionId)).catch(() => {});
    throw e;
  }
}
