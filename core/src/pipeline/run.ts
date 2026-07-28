import { type Pool } from "pg";
import type { Ejecucion, Resultado, RunExecutor, Storage, Version } from "../types.ts";
import { conOrg } from "../db/pg.ts";
import { PgStateRepo } from "../state/pg.ts";
import { ejecutar } from "./build-pipeline.ts";
import { comoSuspension } from "../ops/killswitch.ts";
import { type MetaEntrada } from "../entrada/puente.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Orquestación del RUN (a5): dispara una automatización YA CONSTRUIDA sobre insumos. Es la
// análoga de arrancarConstruccion/cosecha, pero para la EJECUCIÓN. Vive en el core
// (framework-agnóstico): el wiring HTTP o el runner (gVisor, Fase 2) la invoca con el pool +
// el Storage (R2) + el RunExecutor (la jaula). En pruebas/dev se inyecta LocalStorage +
// LocalPythonExecutor + el Postgres temporal — MISMO código, SIN credenciales.
//
// El Run NO usa modelos (docs/01): es código puro; lo caro (Build, agentes) ya ocurrió. Cada
// paso abre su propia tx corta vía PgStateRepo (como en producción, docs/03); por eso recibe
// el POOL, no el `cliente` de un solo request (que ataría todo el run a una transacción).
//
// El código de IA corre en el RUNNER, no en un route serverless de Vercel (LocalPythonExecutor
// ni puede spawn ahí; en producción es la jaula gVisor/CMA). Por eso la exposición HTTP va
// diferida al runner de Fase 2 — esta función es exactamente lo que ese runner invoca.
// ─────────────────────────────────────────────────────────────────────────────

/** No hay una versión EJECUTABLE (ready/lista con artefacto) para esa automatización — o el
 *  build no ha terminado, o la automatización es de OTRA org (RLS la esconde → 0 filas). El
 *  llamador la mapea a 404. Nunca revela si existe en otro tenant. */
export class SinVersionEjecutable extends Error {
  constructor(public readonly automatizacionId: string) {
    super(`Sin versión ejecutable para la automatización ${automatizacionId} (¿build en curso, o ajena?).`);
    this.name = "SinVersionEjecutable";
  }
}

export interface RunDeps {
  pool: Pool;
  storage: Storage;
  run: RunExecutor;
  ahora: () => string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

interface VerRow { id: string; automatizacion_id: string; numero: number; estado: Version["estado"]; artefacto_key: string; creada: Date | string }

/** Dispara la versión ejecutable más reciente de una automatización sobre `inputs`
 *  (nombre → ruta de archivo local). Devuelve el Resultado ya resuelto (lo que el front
 *  renderiza) + la fila de ejecución confirmada. */
export async function ejecutarAutomatizacion(
  deps: RunDeps,
  args: { orgId: string; automatizacionId: string; inputs: Record<string, string>; metas?: Record<string, MetaEntrada> },
): Promise<{ resultado: Resultado; ejecucion: Ejecucion; ms: number }> {
  // 1. FRENO primero (docs/11 §10): el choke-point TEMPRANO del kill-switch, ANTES de inflar
  //    los insumos o correr el código de IA. Si ejecuciones está congelado o la org suspendida,
  //    aborta aquí sin gastar nada. (La reserva en `ejecutar` lo re-checa como backstop.)
  await conOrg(deps.pool, args.orgId, (c) => c.query("SELECT verificar_freno('ejecuciones')")).catch(comoSuspension);

  // 2. Resolver la versión EJECUTABLE más reciente (ready/lista con artefacto). RLS acota a la
  //    org: una automatización ajena devuelve 0 filas → SinVersionEjecutable (cross-org bloqueado).
  const r = await conOrg(deps.pool, args.orgId, (c) =>
    c.query<VerRow>(
      "SELECT id, automatizacion_id, numero, estado, artefacto_key, creada FROM versiones WHERE automatizacion_id = $1 AND estado IN ('ready','lista') AND artefacto_key IS NOT NULL ORDER BY numero DESC LIMIT 1",
      [args.automatizacionId],
    ),
  );
  const row = r.rows[0];
  if (!row) throw new SinVersionEjecutable(args.automatizacionId);
  const version: Version = {
    id: row.id, automatizacionId: row.automatizacion_id, numero: row.numero,
    estado: row.estado, artefactoKey: row.artefacto_key, creada: iso(row.creada),
  };

  // 3. reserva→corre→confirma→resolver. PgStateRepo hace cumplir cuota (cobrar_ejecucion) y
  //    kill-switch (trg_kill_run) EN la reserva; el executor corre SIN red/secretos (a5). Si el
  //    run falla, la ejecución queda 'fallo' (y la reserva ya cobró: "el que falla paga", docs/06).
  const state = new PgStateRepo(deps.pool, args.orgId);
  const { resultado, ejecucion, ms } = await ejecutar(
    { storage: deps.storage, state, run: deps.run, ahora: deps.ahora },
    { version, inputs: args.inputs, metas: args.metas },
  );
  return { resultado, ejecucion, ms };
}
