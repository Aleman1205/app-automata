"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { SignUp } from "@clerk/nextjs";
import { MARCA } from "@/lib/marca";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { CLERK_ACTIVO } from "@/lib/automata/dev";

// Ruta CATCH-ALL ([[...rest]]) a propósito: Clerk enruta sus sub-flujos bajo /entrar
// (p.ej. /entrar/sso-callback tras Google OAuth, /entrar/factor-one, etc.). Con una página
// única esas sub-rutas darían 404. `path="/registrarse" signInUrl="/entrar"` le dice a Clerk cuál es la base.
export default function Registrarse() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="flex w-full max-w-sm flex-col items-center"
      >
        <Link
          href="/"
          className="mb-8 block text-center text-2xl font-black tracking-tight"
        >
          {MARCA}
          <span className="text-acento">.</span>
        </Link>

        {CLERK_ACTIVO ? (
          // Login REAL. path="/registrarse" signInUrl="/entrar" para que sus sub-rutas (sso-callback, etc.) caigan aquí.
          <SignUp path="/registrarse" signInUrl="/entrar" fallbackRedirectUrl="/portafolio" />
        ) : (
          // Modo dev: el bypass de auth ya te tiene "dentro" — entra directo.
          <div className="w-full rounded-2xl border border-linea bg-hueso p-8">
            <h1 className="text-2xl font-black tracking-tight">Modo dev</h1>
            <div className="mt-4 rounded-xl border border-linea bg-papel px-4 py-3">
              <Etiqueta punto>Bypass de auth (solo local)</Etiqueta>
              <p className="mt-1.5 text-xs leading-relaxed text-sepia">
                Estás en modo dev: ya estás autenticado como el usuario de prueba.
                Entra directo.
              </p>
            </div>
            <div className="mt-6">
              <Boton
                href="/portafolio"
                variante="acento"
                icono="flecha"
                className="w-full"
              >
                Entrar
              </Boton>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  );
}
