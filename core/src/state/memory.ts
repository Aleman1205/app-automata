import type {
  Automatizacion,
  Ejecucion,
  StateRepo,
  Version,
} from "../types.ts";

// Estado en memoria (M0). En M2 se cambia por Postgres/Neon con RLS por org_id,
// misma interfaz. Los ids son deterministas por contador para no depender de
// Math.random/Date en el core (se inyecta el reloj desde afuera si hace falta).
export class MemoryStateRepo implements StateRepo {
  private autos = new Map<string, Automatizacion>();
  private versiones = new Map<string, Version>();
  private ejecuciones = new Map<string, Ejecucion>();
  private n = 0;

  private id(prefijo: string): string {
    this.n += 1;
    return `${prefijo}_${this.n}`;
  }

  async crearAutomatizacion(a: Omit<Automatizacion, "id">): Promise<Automatizacion> {
    const auto: Automatizacion = { ...a, id: this.id("auto") };
    this.autos.set(auto.id, auto);
    return auto;
  }

  async crearVersion(v: Omit<Version, "id">): Promise<Version> {
    const version: Version = { ...v, id: this.id("ver") };
    this.versiones.set(version.id, version);
    return version;
  }

  async actualizarVersion(id: string, cambios: Partial<Version>): Promise<Version> {
    const actual = this.versiones.get(id);
    if (!actual) throw new Error(`Versión no encontrada: ${id}`);
    const nueva = { ...actual, ...cambios, id };
    this.versiones.set(id, nueva);
    return nueva;
  }

  async crearEjecucion(e: Omit<Ejecucion, "id">): Promise<Ejecucion> {
    const ejec: Ejecucion = { ...e, id: this.id("run") };
    this.ejecuciones.set(ejec.id, ejec);
    return ejec;
  }

  async obtenerVersion(id: string): Promise<Version | undefined> {
    return this.versiones.get(id);
  }
}
