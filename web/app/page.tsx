import { Hero } from "./_landing/hero";
import { NombreGigante } from "./_landing/nombre-gigante";
import { MarquesinaPasos } from "./_landing/marquesina-pasos";
import { ComoFunciona } from "./_landing/como-funciona";
import { Resultado } from "./_landing/resultado";
import { Confianza } from "./_landing/confianza";
import { PreciosTeaser } from "./_landing/precios-teaser";
import { CtaFinal } from "./_landing/cta-final";

// Landing pública: hero con demo, marca gigante, marquesina de pasos,
// cómo funciona, adelanto del resultado, confianza, precios y CTA final.
export default function Inicio() {
  return (
    <>
      <Hero />
      <NombreGigante />
      <MarquesinaPasos />
      <ComoFunciona />
      <Resultado />
      <Confianza />
      <PreciosTeaser />
      <CtaFinal />
    </>
  );
}
