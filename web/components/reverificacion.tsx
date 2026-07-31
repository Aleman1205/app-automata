"use client";

import { useEffect } from "react";
import { useReverification } from "@clerk/nextjs";
import { registrarTransporte, type Transporte } from "@/lib/automata/lectura";
import { CLERK_ACTIVO } from "@/lib/automata/dev";

// Re-verificación de MFA sin callejón sin salida.
//
// Las acciones peligrosas (invitar, quitar gente, facturación) exigen MFA verificado hace ≤5 min.
// Cuando caducaba, el backend devolvía 403 y el front solo podía decir "cierra sesión y vuelve a
// entrar": una salida real, pero pésima — el cliente perdía lo que estaba haciendo.
//
// `useReverification` de Clerk envuelve una llamada; si la respuesta trae la PISTA
// (`{clerk_error:{type:"forbidden",reason:"reverification-error"}}`, que el wiring añade al 403),
// abre su modal, espera a que el usuario se verifique y REINTENTA la misma petición. El cliente ni
// se entera de que hubo un 403.
//
// Se registra un transporte global en lugar de envolver cada llamada: `useReverification` es un
// hook y las funciones de `lectura.ts` no son componentes. Ver `registrarTransporte`.

function ConClerk() {
  // El fetcher es GENÉRICO —ejecuta el thunk que le den— así que un solo hook cubre todas las
  // acciones. Clerk inspecciona lo que devuelve: si es un Response, le hace .json() y busca la
  // pista; si la encuentra, abre el modal y vuelve a llamar al MISMO thunk.
  const enviar = useReverification((peticion: () => Promise<Response>) => peticion());
  useEffect(() => {
    registrarTransporte(enviar as Transporte);
  }, [enviar]);
  return null;
}

/**
 * Móntalo UNA vez dentro del ClerkProvider. En modo dev (Clerk apagado) no monta nada: llamar
 * `useReverification` sin ClerkProvider lanza, y por eso son dos componentes distintos y no una
 * rama dentro del mismo — cada uno tiene su propio orden de hooks, estable entre renders.
 */
export function ProveedorReverificacion() {
  return CLERK_ACTIVO ? <ConClerk /> : null;
}
