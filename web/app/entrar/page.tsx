"use client";

import Link from "next/link";
import { useState } from "react";
import { motion } from "motion/react";
import { Lock, Mail } from "lucide-react";
import { MARCA } from "@/lib/marca";
import { Boton } from "@/components/ui/boton";
import { Etiqueta } from "@/components/ui/etiqueta";
import { usuarioActual } from "@/lib/datos";

// Login de PRUEBA: los campos son decorativos y no se validan — el botón
// "Entrar" siempre lleva al panel. Cuando haya auth real, aquí entra Clerk.
export default function Entrar() {
  const yo = usuarioActual();
  const [correo, setCorreo] = useState(yo.correo);
  const [clave, setClave] = useState("demo1234");

  const campo =
    "w-full rounded-xl border border-linea bg-hueso py-3 pr-4 pl-11 text-sm transition focus:border-tinta focus:outline-none";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-sm"
      >
        {/* Marca */}
        <Link
          href="/"
          className="mb-10 block text-center text-2xl font-black tracking-tight"
        >
          {MARCA}
          <span className="text-acento">.</span>
        </Link>

        <div className="rounded-2xl border border-linea bg-hueso p-8">
          <h1 className="text-2xl font-black tracking-tight">
            Entra a tu cuenta
          </h1>
          <p className="mt-1.5 text-sm text-sepia">
            Qué gusto verte de vuelta.
          </p>

          {/* Aviso de demo */}
          <div className="mt-5 rounded-xl border border-linea bg-papel px-4 py-3">
            <Etiqueta punto>Modo demo</Etiqueta>
            <p className="mt-1.5 text-xs leading-relaxed text-sepia">
              Es una prueba: no se valida nada. Pica <b>Entrar</b> y pasas
              directo a la app como {yo.nombre.split(" ")[0]}.
            </p>
          </div>

          {/* Campos (decorativos) */}
          <div className="mt-6 flex flex-col gap-3">
            <div className="relative">
              <Mail className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-sepia" />
              <input
                type="email"
                value={correo}
                onChange={(e) => setCorreo(e.target.value)}
                placeholder="tu@correo.mx"
                className={campo}
              />
            </div>
            <div className="relative">
              <Lock className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-sepia" />
              <input
                type="password"
                value={clave}
                onChange={(e) => setClave(e.target.value)}
                placeholder="Tu contraseña"
                className={campo}
              />
            </div>
          </div>

          <div className="mt-6">
            <Boton
              href="/panel"
              variante="acento"
              icono="flecha"
              className="w-full"
            >
              Entrar
            </Boton>
          </div>
        </div>

        <p className="mt-6 text-center text-sm text-sepia">
          ¿Primera vez?{" "}
          <Link href="/nueva" className="font-semibold text-tinta hover:underline">
            Crea tu primera automatización
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
