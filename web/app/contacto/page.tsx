"use client";

import { useState } from "react";
import { Mail, MessageSquare, User } from "lucide-react";
import { Etiqueta } from "@/components/ui/etiqueta";
import { Boton } from "@/components/ui/boton";
import { Reveal } from "@/components/motion/reveal";
import { TextoRevelado } from "@/components/motion/texto-revelado";
import { useAviso } from "@/components/ui/aviso";

export default function Contacto() {
  const { avisar, elemento } = useAviso();
  const [nombre, setNombre] = useState("");
  const [correo, setCorreo] = useState("");
  const [mensaje, setMensaje] = useState("");

  const enviar = () => {
    avisar("Mensaje enviado — te respondemos pronto (demo)");
    setNombre("");
    setCorreo("");
    setMensaje("");
  };

  const campo =
    "w-full rounded-xl border border-linea bg-hueso py-3 pr-4 pl-11 text-sm transition focus:border-tinta focus:outline-none";

  return (
    <div className="mx-auto max-w-3xl px-6 pt-36 pb-24 md:pt-44">
      <Reveal>
        <Etiqueta punto>Contacto</Etiqueta>
      </Reveal>
      <TextoRevelado
        como="h1"
        texto="Hablemos."
        className="mt-4 text-5xl font-black tracking-tight md:text-6xl"
        retraso={0.1}
      />
      <Reveal retraso={0.3}>
        <p className="mt-6 max-w-lg text-lg leading-relaxed text-sepia">
          ¿Tienes un proceso en mente, una duda, o quieres ver una demo? Déjanos
          un mensaje y te contestamos, normalmente el mismo día.
        </p>
      </Reveal>

      <div className="mt-12 grid gap-10 md:grid-cols-[1.4fr_1fr]">
        {/* Formulario */}
        <Reveal retraso={0.15}>
          <div className="flex flex-col gap-3">
            <div className="relative">
              <User className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-sepia" />
              <input
                value={nombre}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Tu nombre"
                className={campo}
              />
            </div>
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
              <MessageSquare className="pointer-events-none absolute top-4 left-4 size-4 text-sepia" />
              <textarea
                value={mensaje}
                onChange={(e) => setMensaje(e.target.value)}
                placeholder="Cuéntanos qué necesitas…"
                rows={5}
                className={`${campo} resize-none pt-3`}
              />
            </div>
            <div className="mt-2">
              <Boton
                variante="acento"
                icono="flecha"
                onClick={enviar}
                deshabilitado={!nombre.trim() || !correo.trim() || !mensaje.trim()}
              >
                Enviar mensaje
              </Boton>
            </div>
          </div>
        </Reveal>

        {/* Datos directos */}
        <Reveal retraso={0.25}>
          <div className="flex flex-col gap-6">
            <div>
              <Etiqueta className="mb-2">Correo</Etiqueta>
              <p className="text-sepia">hola@automata.mx</p>
            </div>
            <div>
              <Etiqueta className="mb-2">Soporte</Etiqueta>
              <p className="text-sepia">
                Desde tu cuenta, o en soporte@automata.mx
              </p>
            </div>
            <div>
              <Etiqueta className="mb-2">Horario</Etiqueta>
              <p className="text-sepia">Lunes a viernes, 9:00 a 18:00 (CDMX)</p>
            </div>
          </div>
        </Reveal>
      </div>

      {elemento}
    </div>
  );
}
