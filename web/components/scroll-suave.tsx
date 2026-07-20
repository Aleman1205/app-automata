"use client";

import { useEffect } from "react";
import Lenis from "lenis";

declare global {
  interface Window {
    __lenis?: Lenis;
  }
}

// Scroll suave global (Lenis). Para hacer scroll programático:
//   window.__lenis?.scrollTo(elemento, { offset: -120 })
export function ScrollSuave() {
  useEffect(() => {
    const lenis = new Lenis({ duration: 1.1 });
    window.__lenis = lenis;
    let raf = 0;
    const ciclo = (t: number) => {
      lenis.raf(t);
      raf = requestAnimationFrame(ciclo);
    };
    raf = requestAnimationFrame(ciclo);
    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
      window.__lenis = undefined;
    };
  }, []);
  return null;
}
