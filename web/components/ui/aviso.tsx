"use client";

import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";

// Toast mínimo. Uso:
//   const { avisar, elemento } = useAviso();
//   ... onClick={() => avisar("Descargado (demo)")} ... {elemento}
export function useAviso() {
  const [mensaje, setMensaje] = useState<string | null>(null);

  const avisar = useCallback((texto: string) => {
    setMensaje(texto);
    setTimeout(() => setMensaje(null), 2600);
  }, []);

  const elemento = (
    <AnimatePresence>
      {mensaje && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 400, damping: 28 }}
          className="fixed bottom-8 left-1/2 z-[95] -translate-x-1/2"
        >
          <div className="flex items-center gap-2.5 rounded-full bg-noche px-5 py-3 text-sm font-medium text-crema shadow-xl shadow-noche/25">
            <Check className="size-4 text-oliva" strokeWidth={3} />
            {mensaje}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return { avisar, elemento };
}
