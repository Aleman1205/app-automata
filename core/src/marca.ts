// ─────────────────────────────────────────────────────────────────────────────
// LA MARCA — fuente ÚNICA del nombre y el dominio.
//
// Vive en `core/` y no en `web/` porque el core también escribe texto que LEE EL CLIENTE:
// el correo de invitación (`ops/notificaciones.ts`) dice el nombre de la empresa. Cuando el
// nombre vivía solo en `web/lib/marca.ts`, ese correo lo tenía hardcodeado — o sea que
// renombrar la empresa dejaba correos saliendo con el nombre viejo, y nadie se enteraba
// hasta que un invitado lo recibiera.
//
// `web/lib/marca.ts` REEXPORTA de aquí. No dupliques el literal en ningún lado: si algo
// necesita el nombre, lo importa.
// ─────────────────────────────────────────────────────────────────────────────

/** Nombre de la empresa tal como lo ve el cliente. */
export const MARCA = "Nokron";

/** Dominio público. Alimenta el `metadataBase` (URLs absolutas de las imágenes al
 *  compartir el link) y los correos de contacto. */
export const DOMINIO = "nokron.mx";

/** Correos públicos derivados del dominio — que no se escriban a mano en las páginas. */
export const CORREO_CONTACTO = `hola@${DOMINIO}`;
export const CORREO_SOPORTE = `soporte@${DOMINIO}`;
