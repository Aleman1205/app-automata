import { PaginaTexto } from "@/components/ui/pagina-texto";
import { MARCA } from "@/lib/marca";

export const metadata = { title: `Sobre nosotros — ${MARCA}` };

export default function Sobre() {
  return (
    <PaginaTexto
      etiqueta="Sobre nosotros"
      titulo="Automatizar sin programar."
      entrada="Miles de negocios repiten cada mes el mismo trabajo a mano — juntar
        ventas, consolidar facturas, limpiar listas. Nosotros creemos que eso lo
        debería hacer el software, no una persona con una tarde perdida."
      secciones={[
        {
          titulo: "Qué hacemos",
          parrafos: [
            "Describes tu proceso en tus palabras. Un equipo de agentes lo entiende, lo construye, lo prueba y lo deja listo en tu portafolio. Tú nunca ves una línea de código.",
            "Cada automatización queda guardada y la ejecutas las veces que quieras, subiendo tus archivos y descargando el resultado en segundos.",
          ],
        },
        {
          titulo: "Para quién es",
          parrafos: [
            "Para el negocio que hace su operación a mano: el hotel, el restaurante, la agencia, el despacho. Gente que conoce su trabajo al derecho y al revés, pero no tiene por qué saber de tecnología.",
          ],
        },
        {
          titulo: "En qué creemos",
          parrafos: [
            "En que la herramienta se adapta a tu proceso, no tu proceso a la herramienta.",
            "En decir la verdad: si algo no se puede todavía, lo decimos. Si algo deja de funcionar, lo reparamos sin cobrarte.",
            "En que la primera vez que ves tu propio proceso resuelto solo, entiendes de qué se trata todo esto.",
          ],
        },
      ]}
      pie="Este es un prototipo. Los datos y la marca son de demostración."
    />
  );
}
