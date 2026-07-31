// El nombre y el dominio viven en `core/src/marca.ts` (fuente única: el core también los usa
// en el correo de invitación, que lo tenía hardcodeado). Aquí solo se reexportan para que el
// front los siga importando desde "@/lib/marca".
export { MARCA, DOMINIO, CORREO_CONTACTO, CORREO_SOPORTE } from "automata-core/marca";

export const ESLOGAN = "Tu proceso, construido por agentes.";
