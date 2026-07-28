import { crearAutomatizacion, invitarMiembro } from "../billing/cuota.ts";
import { congelar, AjusteNoPermitido } from "../ciclo/servicio.ts";
import { IntakeAgent, IntakeError } from "../intake/agent.ts";
import { type EntradaHistorial } from "../intake/prompt.ts";
import { verificarFreno } from "../ops/killswitch.ts";
import { type Rol } from "../auth/roles.ts";
import { type Endpoint } from "./pipeline.ts";
import { type Esquema, R } from "./tipos.ts";
import type { Spec } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints reales cableados sobre withEfecto: cada uno declara su método + acción
// (→ rol + step-up) y su esquema, y su handler usa el cliente ya dentro de conOrg.
// Esto es lo que un route.ts de Next envuelve. Los esquemas aquí son mínimos; en
// producción los respalda Zod (mismo contrato Esquema<T>).
// ─────────────────────────────────────────────────────────────────────────────

const esObjeto = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

const esquemaNombre: Esquema<{ nombre: string }> = {
  analizar(x) {
    if (!esObjeto(x)) return { ok: false, problemas: ["cuerpo no es objeto"] };
    const n = x["nombre"];
    if (typeof n !== "string" || n.trim().length === 0) return { ok: false, problemas: ["nombre requerido"] };
    if (n.length > 200) return { ok: false, problemas: ["nombre > 200"] };
    return { ok: true, valor: { nombre: n.trim() } };
  },
};

const esquemaInvitar: Esquema<{ userId: string; rol: Rol }> = {
  analizar(x) {
    if (!esObjeto(x)) return { ok: false, problemas: ["cuerpo no es objeto"] };
    const u = x["userId"];
    const r = x["rol"];
    if (typeof u !== "string" || u.trim().length === 0) return { ok: false, problemas: ["userId requerido"] };
    if (r !== "admin" && r !== "operador") return { ok: false, problemas: ["rol inválido"] };
    return { ok: true, valor: { userId: u.trim(), rol: r } };
  },
};

// Quitar solo necesita a QUIÉN (el rol del objetivo se lee vivo de la DB, no del cuerpo).
const esquemaUserId: Esquema<{ userId: string }> = {
  analizar(x) {
    if (!esObjeto(x)) return { ok: false, problemas: ["cuerpo no es objeto"] };
    const u = x["userId"];
    if (typeof u !== "string" || u.trim().length === 0) return { ok: false, problemas: ["userId requerido"] };
    return { ok: true, valor: { userId: u.trim() } };
  },
};

const esquemaVacio: Esquema<Record<string, never>> = { analizar: () => ({ ok: true, valor: {} }) };

/** Crear una automatización (admin). El trigger de cuota impone el tope de espacios. */
export const crearAutomatizacionEP: Endpoint<{ nombre: string }> = {
  nombre: "POST /orgs/:orgId/automatizaciones",
  metodo: "POST",
  accion: "crear_build",
  esquema: esquemaNombre,
  handler: async ({ cliente, input }) => R.creado({ id: await crearAutomatizacion(cliente, input.nombre) }),
};

/** Invitar a un miembro (admin, PELIGROSA → step-up: añadir un admin con cookie robada
 *  sería escalada). El trigger de cuota impone el tope de usuarios. */
export const invitarEP: Endpoint<{ userId: string; rol: Rol }> = {
  nombre: "POST /orgs/:orgId/miembros",
  metodo: "POST",
  accion: "invitar",
  esquema: esquemaInvitar,
  handler: async ({ cliente, input }) => {
    await invitarMiembro(cliente, input.userId, input.rol);
    return R.creado({ ok: true });
  },
};

/** Quitar a un miembro (admin, PELIGROSA → step-up). No deja la org sin ningún admin. */
export const quitarMiembroEP: Endpoint<{ userId: string }> = {
  nombre: "DELETE /orgs/:orgId/miembros",
  metodo: "DELETE",
  accion: "quitar_gente",
  esquema: esquemaUserId,
  handler: async ({ cliente, input }) => {
    const obj = await cliente.query<{ rol: Rol }>("SELECT rol FROM memberships WHERE user_id = $1", [input.userId]);
    const rol = obj.rows[0]?.rol;
    if (!rol) return R.malParametro("no es miembro de esta org");
    if (rol === "admin") {
      const n = await cliente.query<{ n: number }>("SELECT count(*)::int AS n FROM memberships WHERE rol = 'admin'");
      if ((n.rows[0]?.n ?? 0) <= 1) return R.prohibido("no_puede_quedar_sin_admin");
    }
    await cliente.query("DELETE FROM memberships WHERE user_id = $1", [input.userId]);
    return R.ok({ ok: true });
  },
};

/** Ejecutar una automatización (admin y operador). STUB del wrapping: prueba el camino
 *  operador + conOrg + freno. NO consume cuota a mano: la cuota de ejecuciones la cobra
 *  el TRIGGER `cobrar_ejecucion` al insertar la fila del ledger `ejecuciones` (única
 *  fuente — así el contador no diverge del ledger). El endpoint de producción corre el
 *  run vía build-pipeline.ejecutar → PgStateRepo.crearEjecucion (reserva→corre→confirma),
 *  cuyo INSERT dispara el trigger. Consumir aquí ADEMÁS sería doble-cobro (revisión). El
 *  kill-switch se consulta antes de todo (verificarFreno): si ejecuciones está congelado
 *  o la org suspendida, ni se corre (docs/11 §10 — el freno muerde ANTES del run). */
// Disparo de build (a3-s6): recibe una spec APROBADA (del intake) + la clave del ejemplo ya
// subido, y ENCOLA la solicitud (app_solicitar_build). El planner + arrancarConstruccion los
// corre el drainer FUERA del request (I/O de modelo + CMA). NO se corre nada caro aquí.
interface SolicitudBuild { nombre: string; spec: Spec; ejemploKey: string; }
const MAX = 400;
const arrStr = (x: unknown, min: number, max: number): string[] | null => {
  if (!Array.isArray(x) || x.length < min || x.length > max) return null;
  const out: string[] = [];
  for (const v of x) { if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX) return null; out.push(v.trim()); }
  return out;
};
const esquemaSolicitud: Esquema<SolicitudBuild> = {
  analizar(x) {
    if (!esObjeto(x)) return { ok: false, problemas: ["cuerpo no es objeto"] };
    const nombre = x["nombre"];
    if (typeof nombre !== "string" || nombre.trim().length === 0 || nombre.length > 200) return { ok: false, problemas: ["nombre requerido (≤200)"] };
    const ejemploKey = x["ejemploKey"];
    // Clave del ejemplo ya subido; se scopea a la org en el handler. Sin traversal ni rutas raras.
    if (typeof ejemploKey !== "string" || !/^ejemplos\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/.test(ejemploKey)) return { ok: false, problemas: ["ejemploKey inválida"] };
    const s = x["spec"];
    if (!esObjeto(s)) return { ok: false, problemas: ["spec requerido"] };
    const objetivo = s["objetivo"];
    if (typeof objetivo !== "string" || objetivo.trim().length === 0 || objetivo.length > 2000) return { ok: false, problemas: ["spec.objetivo requerido"] };
    const reglas = arrStr(s["reglas"], 0, 15);
    const criterios = arrStr(s["criterios_exito"], 1, 10);
    if (!reglas) return { ok: false, problemas: ["spec.reglas inválidas (≤15)"] };
    if (!criterios) return { ok: false, problemas: ["spec.criterios_exito inválidos (1-10)"] };
    if (!Array.isArray(s["entradas"])) return { ok: false, problemas: ["spec.entradas inválido"] };
    const entradas = (s["entradas"] as unknown[]).map((e) => (esObjeto(e) ? { tipo: String(e["tipo"] ?? ""), formato: String(e["formato"] ?? ""), descripcion: String(e["descripcion"] ?? "").slice(0, MAX) } : { tipo: "", formato: "", descripcion: "" }));
    return { ok: true, valor: { nombre: nombre.trim(), ejemploKey, spec: { objetivo: objetivo.trim(), reglas, criterios_exito: criterios, entradas } } };
  },
};
export const solicitarBuildEP: Endpoint<SolicitudBuild> = {
  nombre: "POST /orgs/:orgId/construir",
  metodo: "POST",
  accion: "crear_build",
  esquema: esquemaSolicitud,
  handler: async ({ cliente, input, orgId }) => {
    // La clave del ejemplo DEBE estar bajo el prefijo de ESTA org (anti cross-org: que no
    // pida construir con el ejemplo/artefacto de otro tenant).
    if (!input.ejemploKey.startsWith(`ejemplos/${orgId}/`)) return R.malParametro("ejemploKey fuera de la org");
    const r = await cliente.query<{ id: string }>("SELECT app_solicitar_build($1,$2,$3) AS id", [input.nombre, JSON.stringify(input.spec), input.ejemploKey]);
    return R.creado({ id: r.rows[0]?.id }); // solicitud encolada; el drainer construye
  },
};

// ── Intake por-turno (POST): corre UNA ronda del entrevistador (Sonnet) ───────
// El front maneja la conversación: manda { idea, historial, turno } y recibe la siguiente
// ronda de preguntas o el spec (o rechazo). Acción "crear_build" (admin). NOTA: la llamada a
// Sonnet (~5-10s) corre dentro de conOrg, así que retiene una conexión de la BD ese rato; para
// alto tráfico convendría sacarla de la tx (follow-up). El intake NO usa la BD, solo el modelo.
const esquemaIntake: Esquema<{ idea: string; historial: EntradaHistorial[]; turno: number }> = {
  analizar(x) {
    if (!esObjeto(x)) return { ok: false, problemas: ["cuerpo no es objeto"] };
    const idea = x["idea"];
    if (typeof idea !== "string" || idea.trim().length === 0 || idea.length > 2000) return { ok: false, problemas: ["idea requerida (≤2000)"] };
    const turno = x["turno"];
    if (typeof turno !== "number" || !Number.isInteger(turno) || turno < 1 || turno > 3) return { ok: false, problemas: ["turno debe ser 1-3"] };
    const h = x["historial"];
    if (!Array.isArray(h)) return { ok: false, problemas: ["historial inválido"] };
    const historial: EntradaHistorial[] = [];
    for (const e of h) {
      if (!esObjeto(e) || typeof e["pregunta"] !== "string" || typeof e["eleccion"] !== "string" || typeof e["libre"] !== "boolean") return { ok: false, problemas: ["historial mal formado"] };
      historial.push({ pregunta: String(e["pregunta"]).slice(0, 400), eleccion: String(e["eleccion"]).slice(0, 400), libre: e["libre"] });
    }
    return { ok: true, valor: { idea: idea.trim(), historial, turno } };
  },
};
export const intakeEP: Endpoint<{ idea: string; historial: EntradaHistorial[]; turno: number }> = {
  nombre: "POST /orgs/:orgId/intake",
  metodo: "POST",
  accion: "crear_build",
  esquema: esquemaIntake,
  handler: async ({ input }) => {
    try {
      const res = await new IntakeAgent().turno(input.idea, input.historial, input.turno);
      return R.ok(res); // { accion: "preguntar" | "cerrar" | "rechazar", ... }
    } catch (e) {
      if (e instanceof IntakeError) return { status: 422, cuerpo: { error: "intake_fallo", motivo: e.message } };
      throw e;
    }
  },
};

export const ejecutarEP: Endpoint<Record<string, never>> = {
  nombre: "POST /orgs/:orgId/ejecutar",
  metodo: "POST",
  accion: "ejecutar",
  esquema: esquemaVacio,
  handler: async ({ cliente }) => {
    await verificarFreno(cliente, "ejecuciones"); // choke-point del freno, antes de todo
    return R.ok({ ok: true }); // el run real lo hace el pipeline (inserta el ledger → cuota)
  },
};

// ── API de LECTURA (GET): portafolio / panel / detalle ──────────────────────
// Corren bajo conOrg (RLS): cada query ve SOLO la org del contexto. Acción "ver" (admin y
// operador). El id del detalle llega por query (?id=…) — el adaptador lo pone en `cuerpo`.
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
// EstadoAuto de la UI derivado del ciclo + la última versión (contrato de web/lib/datos.ts).
function estadoAuto(ultimaVersion: string | null, ciclo: string): "lista" | "generando" | "fallo" | "congelada" {
  if (ciclo === "frozen") return "congelada";
  if (ultimaVersion === "lista") return "lista";
  if (ultimaVersion === "failed") return "fallo";
  return "generando"; // queued/building/ready o aún sin versión
}
const esquemaLista: Esquema<Record<string, never>> = { analizar: () => ({ ok: true, valor: {} }) };
const esquemaVerId: Esquema<{ id: string }> = {
  analizar(x) {
    const id = esObjeto(x) ? x["id"] : undefined;
    if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) return { ok: false, problemas: ["id (uuid) requerido"] };
    return { ok: true, valor: { id } };
  },
};

export const listarAutomatizacionesEP: Endpoint<Record<string, never>> = {
  nombre: "GET /orgs/:orgId/automatizaciones",
  metodo: "GET",
  accion: "ver",
  esquema: esquemaLista,
  handler: async ({ cliente }) => {
    const r = await cliente.query(
      `SELECT a.id, a.nombre, a.activa, a.ciclo_estado, a.ajustes_usados, a.creada, a.entregada,
         (SELECT v.estado FROM versiones v WHERE v.automatizacion_id = a.id ORDER BY v.numero DESC LIMIT 1) AS ultima,
         (SELECT count(*)::int FROM ejecuciones e JOIN versiones v ON e.version_id = v.id WHERE v.automatizacion_id = a.id) AS ejecuciones,
         (SELECT max(e.creada) FROM ejecuciones e JOIN versiones v ON e.version_id = v.id WHERE v.automatizacion_id = a.id) AS ultima_ejec
       FROM automatizaciones a ORDER BY a.creada DESC`,
    );
    return R.ok({
      automatizaciones: r.rows.map((f) => ({
        id: f.id, nombre: f.nombre, activa: f.activa, cicloEstado: f.ciclo_estado,
        ajustesUsados: f.ajustes_usados, creada: iso(f.creada), entregada: iso(f.entregada),
        estado: estadoAuto(f.ultima ?? null, f.ciclo_estado), ejecuciones: f.ejecuciones, ultimaEjecucion: iso(f.ultima_ejec),
      })),
    });
  },
};

export const verAutomatizacionEP: Endpoint<{ id: string }> = {
  nombre: "GET /orgs/:orgId/automatizacion",
  metodo: "GET",
  accion: "ver",
  esquema: esquemaVerId,
  handler: async ({ cliente, input }) => {
    const a = await cliente.query("SELECT id, nombre, activa, ciclo_estado, ajustes_usados, creada, entregada, en_revision FROM automatizaciones WHERE id = $1", [input.id]);
    const auto = a.rows[0];
    if (!auto) return { status: 404, cuerpo: { error: "no_encontrada" } }; // RLS: ajena/inexistente → 0 filas
    const vs = await cliente.query("SELECT numero, estado, tipo, creada FROM versiones WHERE automatizacion_id = $1 ORDER BY numero DESC", [input.id]);
    const vista = await cliente.query("SELECT vista FROM versiones WHERE automatizacion_id = $1 AND estado = 'lista' AND vista IS NOT NULL ORDER BY numero DESC LIMIT 1", [input.id]);
    const ejec = await cliente.query("SELECT count(*)::int AS n, max(e.creada) AS ultima FROM ejecuciones e JOIN versiones v ON e.version_id = v.id WHERE v.automatizacion_id = $1", [input.id]);
    return R.ok({
      id: auto.id, nombre: auto.nombre, activa: auto.activa, cicloEstado: auto.ciclo_estado,
      ajustesUsados: auto.ajustes_usados, creada: iso(auto.creada), entregada: iso(auto.entregada),
      enRevision: !!auto.en_revision,
      estado: estadoAuto(vs.rows[0]?.estado ?? null, auto.ciclo_estado),
      ejecuciones: ejec.rows[0]?.n ?? 0, ultimaEjecucion: iso(ejec.rows[0]?.ultima ?? null),
      versiones: vs.rows.map((v) => ({ numero: v.numero, estado: v.estado, tipo: v.tipo, creada: iso(v.creada) })),
      vista: vista.rows[0]?.vista ?? null, // el layout de la última versión lista; los DATOS del resultado son otro slice (ejecución)
    });
  },
};

// ── Equipo (GET): miembros de la org ────────────────────────────────────────
// Pantalla de equipo. RLS acota a la org (una fila por miembro). `memberships` es solo
// user_id + rol — NO hay estado "pendiente" (eso era dato falso del prototipo; el modelo
// real no tiene invitaciones a medias). `esTu` marca al usuario que pide, para la UI.
export const listarEquipoEP: Endpoint<Record<string, never>> = {
  nombre: "GET /orgs/:orgId/miembros",
  metodo: "GET",
  accion: "ver",
  esquema: esquemaLista,
  handler: async ({ cliente, identidad }) => {
    const r = await cliente.query<{ user_id: string; rol: Rol }>(
      "SELECT user_id, rol FROM memberships ORDER BY rol, user_id", // admin antes que operador (orden alfabético)
    );
    return R.ok({
      miembros: r.rows.map((f) => ({ userId: f.user_id, rol: f.rol, esTu: f.user_id === identidad.userId })),
      total: r.rows.length,
    });
  },
};

// ── Cuenta / uso (GET): plan + límites + consumo del periodo ─────────────────
// Panel de cuenta. Une subscription (plan/estado/fin de periodo) + los límites del plan
// (tabla `planes`, global) + el consumo: espacios ACTIVOS y usuarios (stock, contados vivos)
// y generaciones/ejecuciones del MES actual (flujo, de uso_periodo). El periodo se computa
// con to_char(now(),'YYYY-MM') — el MISMO que cobra la cuota (cobrar_ejecucion), así lo que
// muestra el panel y lo que se cobra nunca divergen. Todo bajo RLS: solo la org del contexto.
export const verCuentaEP: Endpoint<Record<string, never>> = {
  nombre: "GET /orgs/:orgId/cuenta",
  metodo: "GET",
  accion: "ver",
  esquema: esquemaLista,
  handler: async ({ cliente }) => {
    const r = await cliente.query(
      `SELECT s.plan, s.estado, s.periodo_fin,
         p.espacios, p.generaciones, p.ejecuciones, p.usuarios, p.exportar_codigo, p.reparaciones,
         to_char(now(),'YYYY-MM') AS periodo,
         (SELECT count(*)::int FROM automatizaciones a WHERE a.activa) AS espacios_usados,
         (SELECT count(*)::int FROM memberships m)                    AS usuarios_usados,
         coalesce((SELECT u.generaciones FROM uso_periodo u WHERE u.periodo = to_char(now(),'YYYY-MM')), 0) AS gen_periodo,
         coalesce((SELECT u.ejecuciones  FROM uso_periodo u WHERE u.periodo = to_char(now(),'YYYY-MM')), 0) AS ejec_periodo
       FROM subscriptions s JOIN planes p ON p.plan = s.plan`,
    );
    const f = r.rows[0];
    if (!f) return { status: 404, cuerpo: { error: "sin_cuenta" } }; // org sin subscription (estado roto): RLS 0 filas
    return R.ok({
      plan: { clave: f.plan, estado: f.estado, periodoFin: iso(f.periodo_fin) },
      limites: {
        espacios: f.espacios, usuarios: f.usuarios, generaciones: f.generaciones,
        ejecuciones: f.ejecuciones, exportarCodigo: f.exportar_codigo, reparaciones: f.reparaciones,
      },
      uso: {
        periodo: f.periodo,
        espacios: f.espacios_usados, usuarios: f.usuarios_usados,
        generaciones: f.gen_periodo, ejecuciones: f.ejec_periodo,
      },
    });
  },
};

// ── Historial de ejecuciones (GET): las corridas de una automatización ───────
// Para el detalle. RLS acota a la org. `tieneResultado` = si esa corrida dejó su Resultado
// persistido (descargable). El id (uuid de la automatización) llega por ?id=.
export const listarEjecucionesEP: Endpoint<{ id: string }> = {
  nombre: "GET /orgs/:orgId/ejecuciones",
  metodo: "GET",
  accion: "ver",
  esquema: esquemaVerId,
  handler: async ({ cliente, input }) => {
    const r = await cliente.query(
      `SELECT e.id, e.estado, e.ms, e.creada, e.resultado_key
         FROM ejecuciones e JOIN versiones v ON e.version_id = v.id
        WHERE v.automatizacion_id = $1 ORDER BY e.creada DESC LIMIT 50`,
      [input.id],
    );
    return R.ok({
      ejecuciones: r.rows.map((f) => ({
        id: f.id, estado: f.estado, ms: f.ms, creada: iso(f.creada), tieneResultado: !!f.resultado_key,
      })),
    });
  },
};

/** Congelar una automatización ("hacerla definitiva", admin). Ya no acepta ajustes, pero se
 *  ejecuta igual. `app_congelar` no congela con un cambio en vuelo (anti-brick) → AjusteNoPermitido
 *  se mapea a 409. Se define aquí (después de esquemaVerId) por el orden de evaluación del módulo. */
export const congelarEP: Endpoint<{ id: string }> = {
  nombre: "POST /orgs/:orgId/congelar",
  metodo: "POST",
  accion: "ajustar",
  esquema: esquemaVerId,
  handler: async ({ cliente, input }) => {
    try {
      await congelar(cliente, input.id);
      return R.ok({ ok: true, cicloEstado: "frozen" });
    } catch (e) {
      if (e instanceof AjusteNoPermitido) return { status: 409, cuerpo: { error: "no_se_puede_congelar", motivo: e.message } };
      throw e;
    }
  },
};

// Registro central. NOTA (revisión): esto NO es la garantía anti-olvido completa —
// en Next hace falta un test que ESCANEE app/api/**/route.ts y falle si algún handler
// con efecto no delega en withEfecto. Aquí registrarse es la convención.
export const ENDPOINTS = [crearAutomatizacionEP, invitarEP, quitarMiembroEP, ejecutarEP, solicitarBuildEP, intakeEP, listarAutomatizacionesEP, verAutomatizacionEP, listarEquipoEP, verCuentaEP, listarEjecucionesEP, congelarEP] as const;
