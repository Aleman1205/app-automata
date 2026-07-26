import { crearAutomatizacion, invitarMiembro } from "../billing/cuota.ts";
import { verificarFreno } from "../ops/killswitch.ts";
import { type Rol } from "../auth/roles.ts";
import { type Endpoint } from "./pipeline.ts";
import { type Esquema, R } from "./tipos.ts";

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

// Registro central. NOTA (revisión): esto NO es la garantía anti-olvido completa —
// en Next hace falta un test que ESCANEE app/api/**/route.ts y falle si algún handler
// con efecto no delega en withEfecto. Aquí registrarse es la convención.
export const ENDPOINTS = [crearAutomatizacionEP, invitarEP, quitarMiembroEP, ejecutarEP] as const;
