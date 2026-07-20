import { PaginaTexto } from "@/components/ui/pagina-texto";
import { MARCA } from "@/lib/marca";

export const metadata = { title: `Términos — ${MARCA}` };

export default function Terminos() {
  return (
    <PaginaTexto
      etiqueta="Legal · Términos"
      titulo="Las reglas del juego."
      entrada="En corto y en español: qué te damos, qué esperamos de ti, y qué pasa
        si algo sale mal o decides irte."
      secciones={[
        {
          titulo: "Qué te ofrecemos",
          parrafos: [
            "Una plataforma para crear automatizaciones a partir de la descripción de tu proceso, y ejecutarlas las veces que tu plan permita. Hacemos nuestro mejor esfuerzo por mantener el servicio disponible y funcionando.",
          ],
        },
        {
          titulo: "Tu cuenta y tu equipo",
          parrafos: [
            "La cuenta es de tu negocio, y las automatizaciones son compartidas por todo tu equipo. Tú eres responsable de a quién invitas y de lo que hace tu gente dentro de la cuenta.",
            "Hay dos roles: administrador (crea, ajusta e invita) y operador (solo ejecuta). Tú decides quién es qué.",
          ],
        },
        {
          titulo: "Planes, pago y cuota",
          parrafos: [
            "Cada plan incluye un número de automatizaciones activas y de ejecuciones al mes. Solo cuentan las automatizaciones que quedan listas: si un build falla, no consume tu cuota, y reintentar es gratis.",
            "Cada automatización incluye su construcción y hasta tres ajustes. Las reparaciones —cuando algo deja de funcionar sin que tú lo cambiaras— son gratis e ilimitadas.",
          ],
        },
        {
          titulo: "De quién son tus automatizaciones",
          parrafos: [
            "Tuyas. Los datos que subes y los resultados que generas te pertenecen. En los planes que lo incluyen, puedes exportar el código de tus automatizaciones.",
          ],
        },
        {
          titulo: "Uso aceptable",
          parrafos: [
            "No puedes usar la plataforma para procesar datos que no tienes derecho a usar, ni para crear automatizaciones con fines ilegales o dañinos. Nos reservamos el derecho de suspender cuentas que lo hagan.",
          ],
        },
        {
          titulo: "Si decides irte",
          parrafos: [
            "Puedes cancelar cuando quieras. Conservas acceso de solo lectura durante 30 días para descargar todos tus resultados; después, tus datos se eliminan.",
          ],
        },
      ]}
      pie="Prototipo · texto de demostración, no son términos legales finales"
    />
  );
}
