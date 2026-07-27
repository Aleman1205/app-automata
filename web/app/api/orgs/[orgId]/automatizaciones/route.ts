import { ruta } from "@/lib/automata/wiring";
import { crearAutomatizacionEP, listarAutomatizacionesEP } from "automata-core/http/endpoints";

// POST — crear una automatización (admin). GET — listar las de la org (portafolio/panel, ver).
export const POST = ruta(crearAutomatizacionEP);
export const GET = ruta(listarAutomatizacionesEP);
