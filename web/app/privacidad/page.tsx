import { PaginaTexto } from "@/components/ui/pagina-texto";
import { MARCA } from "@/lib/marca";

export const metadata = { title: `Privacidad — ${MARCA}` };

export default function Privacidad() {
  return (
    <PaginaTexto
      etiqueta="Legal · Privacidad"
      titulo="Tus datos son tuyos."
      entrada="Subes cosas sensibles — ventas, facturas, listas de clientes. Esta
        página explica, sin letra chiquita, qué hacemos y qué no hacemos con
        ellas."
      secciones={[
        {
          titulo: "Qué recopilamos",
          parrafos: [
            "Los archivos que subes para crear y ejecutar tus automatizaciones. La descripción de tu proceso. Los datos de tu cuenta y de tu equipo (nombre, correo, rol). Y datos de uso para cobrar y mejorar el servicio.",
            "No pedimos ni almacenamos datos de tu tarjeta: los pagos los procesa nuestro proveedor de cobros, no nosotros.",
          ],
        },
        {
          titulo: "Cómo los usamos",
          parrafos: [
            "Únicamente para construir y ejecutar tus automatizaciones, darte soporte y facturarte. No vendemos tus datos ni los compartimos con terceros para publicidad.",
            "Para construir cada automatización usamos agentes de inteligencia artificial. Los datos que procesan viven aislados y no se usan para entrenar modelos ajenos a tu cuenta.",
          ],
        },
        {
          titulo: "Cómo los protegemos",
          parrafos: [
            "Los datos de cada cliente viven separados de los de los demás: nadie de otra cuenta puede verlos.",
            "Cada ejecución corre en un entorno aislado que se destruye al terminar, sin conexión a internet — tus archivos no salen de ahí.",
            "Los respaldos están cifrados y con acceso restringido.",
          ],
        },
        {
          titulo: "Cuánto los guardamos",
          parrafos: [
            "Los archivos que subes para una ejecución: 7 días. Los resultados: 30 días, para que puedas volver a descargarlos. El ejemplo con el que se validó una automatización se conserva mientras esa automatización exista, porque es lo que nos permite comprobar que sigue funcionando.",
            "Puedes borrar todo lo tuyo cuando quieras. Cuando lo pides, se elimina de verdad — archivos, historial y rastros de procesamiento — no solo se oculta.",
          ],
        },
        {
          titulo: "Tus derechos",
          parrafos: [
            "Puedes acceder, corregir o borrar tus datos en cualquier momento desde tu cuenta o escribiéndonos. Si cancelas, conservas acceso de solo lectura durante 30 días para descargar todo antes de que se elimine.",
          ],
        },
      ]}
      pie="Prototipo · texto de demostración, no es un aviso de privacidad final"
    />
  );
}
