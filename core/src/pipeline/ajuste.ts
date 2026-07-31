import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Pool } from "pg";
import { conOrg } from "../db/pg.ts";
import { iniciarAjuste, fallarAjuste } from "../ciclo/servicio.ts";
import { PgStateRepo } from "../state/pg.ts";
import type { Artefacto, BuildClientAsync, PeticionAjuste, Spec, Storage, Vista } from "../types.ts";
import type { ResultadoRegresion, TipoAjuste } from "../ciclo/estados.ts";
import type { Notificador } from "../ops/notificaciones.ts";
import type { Planeador } from "./disparo.ts";
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
  // OBLIGATORIA a propósito: una versión sin vista se entrega 'lista' y truena al ejecutarla. El
  // tipo es lo que impide que vuelva a olvidarse — antes `vista` ni existía aquí y el drainer
  // llamaba feliz sin ella. Va JUNTO con contratoTexto: los dos salen del MISMO plan y la vista
  // referencia @resultado.* del contrato; mandar uno sin el otro rompe el acoplamiento.
  vista: Vista;
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

/** Corre la REGRESIÓN: el ejemplo original contra la versión vigente. Es lo que decide si el
 *  cliente paga o no (docs/08 §2), así que no se adivina.
 *
 *  Hoy devuelve "indeterminado" —que el ciclo trata como CAMBIO, fail-safe— porque correrla exige
 *  ejecutar el artefacto y el Run de producción todavía no existe (runner gVisor sin desplegar).
 *  Deliberadamente NO se devuelve "falla" por defecto: eso volvería gratis cualquier cambio con solo
 *  reportarlo como avería. El cliente NO se lleva la sorpresa: el endpoint le dice de frente que
 *  contará como cambio ANTES de comprometer nada, y él decide. Cuando el runner exista, esta función
 *  ejecuta el ejemplo y devuelve "pasa"/"falla" con datos. */
export async function correrRegresion(opts?: { entregada?: string | Date | null }): Promise<ResultadoRegresion> {
  // NUNCA ENTREGADA ⇒ no hay nada que "cambiar". La regresión compara el ejemplo original contra la
  // versión VIGENTE, y si el primer build falló no existe tal versión: la comparación no es que dé
  // indeterminado, es que no aplica. Cobrarlo como cambio le facturaba al cliente una modificación
  // de algo que nunca recibió, encima del build fallido que ya pagó. Se trata como REPARACIÓN
  // (gratis, permitida aun congelada, acotada por el circuit breaker), que es justo lo que es.
  if (opts && !opts.entregada) return "falla";
  return "indeterminado";
}

/** Arranca el build de un ajuste sobre una automatización que YA existe. Lanza lo que lance el
 *  ciclo (AjusteNoPermitido / AjusteEnCurso / AutomatizacionNoDisponible / CuotaExcedida /
 *  ServicioSuspendido): el llamador los traduce a mensajes de cliente. */
export async function arrancarAjuste(deps: AjusteDeps, args: AjusteArgs): Promise<AjusteArrancado> {
  // 1. RESERVA en una tx corta. iniciarAjuste valida guardas (activa, sin build en vuelo, ajustes
  //    disponibles si es cambio) y persiste el tipo; la BD cobra la generación si es cambio.
  const iniciado = await conOrg(deps.pool, args.orgId, (c) =>
    iniciarAjuste(c, args.automatizacionId, args.regresion, { vista: args.vista }),
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

// ── Drainer de la cola de ajustes ────────────────────────────────────────────
// Misma disciplina que drenarBuilds: el request solo encoló; aquí se hace el trabajo caro
// (regresión + sesión de CMA) fuera de la petición del cliente. Corre con el pool de APP porque el
// ciclo vive bajo RLS — a diferencia del drainer de builds, que necesita el dueño para crear el
// tenant. La org se toma de la FILA, no de un parámetro: la cola es global.

export interface DrenarAjustesDeps extends AjusteDeps {
  // DOS pools, como el drainer de builds: la cola tiene REVOKE ALL para el rol de app (solo se
  // escribe por app_solicitar_ajuste, que valida), así que reclamarla exige el DUEÑO; el ciclo en
  // cambio vive bajo RLS y va con el pool de app (deps.pool).
  poolOwner: Pool;
  // El PLANNER, igual que en el disparo de builds. Faltaba, y ese era el bug: el ajuste construía
  // el código pero la versión nueva nacía sin vista ni contrato, así que se entregaba 'lista' y
  // reventaba al ejecutarla. El cliente pagaba el build y recibía algo inservible.
  planeador: Planeador;
  notificador?: Notificador; // avisa al cliente si su ajuste se descarta (best-effort)
}

const MAX_INTENTOS_AJUSTE = 3;

export async function drenarAjustes(
  deps: DrenarAjustesDeps,
  opts?: { lote?: number },
): Promise<{ arrancados: number; fallidos: number; pendientes: number }> {
  const lote = opts?.lote ?? 10;
  let arrancados = 0, fallidos = 0, pendientes = 0;
  const vistos: string[] = [];
  for (let i = 0; i < lote; i++) {
    // Las vistas se excluyen EN el SELECT (no tras reclamarlas): reclamar para descartar
    // incrementaría `intentos` sin procesar y el presupuesto de reintentos se gastaría al doble.
    const claim = await deps.poolOwner.query<{
      id: string; org_id: string; automatizacion_id: string; peticion: string; intentos: number;
      nombre: string; spec: Spec | null; ejemplo_key: string | null; vista_anterior: Vista | null;
      entregada: Date | null;
    }>(
      // Mismo ARRENDAMIENTO que el disparo de builds, por la misma razón: el lock del claim no
      // sobrevive al trabajo caro, así que sin `tomada_en` dos crons solapados arrancarían dos
      // ajustes de la misma automatización (y el segundo, además, chocaría con el "build en vuelo").
      `UPDATE ajuste_pendiente SET intentos = intentos + 1, tomada_en = now()
         WHERE id = (SELECT ap.id FROM ajuste_pendiente ap
                      WHERE NOT (ap.id = ANY($1::uuid[]))
                        AND (ap.tomada_en IS NULL OR ap.tomada_en < now() - interval '15 minutes')
                      ORDER BY ap.creada FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, org_id, automatizacion_id, peticion, intentos,
                 (SELECT nombre      FROM automatizaciones a WHERE a.id = automatizacion_id) AS nombre,
                 (SELECT spec        FROM automatizaciones a WHERE a.id = automatizacion_id) AS spec,
                 (SELECT ejemplo_key FROM automatizaciones a WHERE a.id = automatizacion_id) AS ejemplo_key,
                 (SELECT entregada    FROM automatizaciones a WHERE a.id = automatizacion_id) AS entregada,
                 -- La vista VIGENTE, para que el planner la EVOLUCIONE en vez de reinventar el
                 -- reporte que el cliente ya reconoce. Se califica con el nombre de la tabla: aquí
                 -- un automatizacion_id a secas resolvería a la columna de versiones (v.automatizacion_id
                 -- = v.automatizacion_id, tautología que traería la vista de CUALQUIER org).
                 (SELECT v.vista FROM versiones v
                   WHERE v.automatizacion_id = ajuste_pendiente.automatizacion_id AND v.estado = 'lista'
                   ORDER BY v.numero DESC LIMIT 1) AS vista_anterior`,
      [vistos],
    );
    const row = claim.rows[0];
    if (!row) break;
    vistos.push(row.id);
    try {
      // Una automatización construida ANTES de que se guardaran spec/ejemplo_key no se puede
      // ajustar: sin ellos el agente no tiene ni criterios ni datos con que probar. Se descarta con
      // aviso en vez de mandarle al agente un spec vacío y entregar cualquier cosa.
      if (!row.spec || !row.ejemplo_key) {
        throw new Error("la automatización no guardó su spec/ejemplo (se construyó antes de que se persistieran): no se puede ajustar");
      }
      const regresion = await correrRegresion({ entregada: row.entregada });
      // PLANEAR ANTES DE RESERVAR (mismo orden que drenarBuilds). iniciarAjuste es lo que COBRA la
      // generación: si el planner truena después de reservar, el cliente ya pagó un build que no
      // existe. Planeando primero, un fallo del planner solo deja el ajuste en la cola para el
      // siguiente intento y nadie paga nada.
      const plan = await deps.planeador.planear(row.spec, {
        peticion: row.peticion,
        vistaAnterior: row.vista_anterior ?? undefined,
      });
      await arrancarAjuste(deps, {
        orgId: row.org_id,
        automatizacionId: row.automatizacion_id,
        peticion: row.peticion,
        spec: row.spec,
        ejemploKey: row.ejemplo_key,
        regresion,
        vista: plan.vista,
        // El contrato tampoco viajaba: el agente construía la v2 sin saber qué forma debía tener el
        // resultado.json, así que aunque la vista hubiera existido, sus refs @resultado.* podían no
        // resolver. Los dos salen del mismo plan justamente para que cuadren.
        contratoTexto: JSON.stringify(plan.resultado_contrato),
      });
      await deps.poolOwner.query("DELETE FROM ajuste_pendiente WHERE id = $1", [row.id]);
      arrancados++;
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      if (row.intentos >= MAX_INTENTOS_AJUSTE) {
        await deps.poolOwner.query("DELETE FROM ajuste_pendiente WHERE id = $1", [row.id]);
        // El cliente pidió un cambio y ya vio "en eso estamos": si se descarta en silencio se queda
        // esperando algo que no va a llegar (el mismo agujero que tenía el disparo de builds).
        await deps.notificador?.notificar({ tipo: "fallo", orgId: row.org_id, nombre: row.nombre }).catch(() => {});
        fallidos++;
      } else {
        pendientes++;
        // Soltar el arrendamiento al fallar (igual que el disparo): protege el trabajo en vuelo, no
        // debe retrasar el reintento.
        await deps.poolOwner.query("UPDATE ajuste_pendiente SET tomada_en = NULL WHERE id = $1", [row.id]).catch(() => {});
        console.error(`[ajuste] error arrancando ${row.id} (intento ${row.intentos}, se reintenta):`, msg);
      }
    }
  }
  return { arrancados, fallidos, pendientes };
}
