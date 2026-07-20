"use client";

// Franja infinita que se desplaza (animshelf: Marquee). Se pausa con el mouse.
// El contenido se duplica para lograr el bucle perfecto: termina cada elemento
// con su separador para que el empalme no se note.
export function Marquesina({
  children,
  duracion = 28,
  className = "",
}: {
  children: React.ReactNode;
  duracion?: number;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden whitespace-nowrap ${className}`}>
      <div
        className="pista-marquesina inline-flex w-max items-center"
        style={{ animationDuration: `${duracion}s` }}
      >
        <div className="inline-flex items-center">{children}</div>
        <div className="inline-flex items-center" aria-hidden>
          {children}
        </div>
      </div>
    </div>
  );
}
