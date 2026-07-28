// ─────────────────────────────────────────────────────────────────────────────
// Modo DEV LOCAL: corre el backend REAL (pipeline de 8 capas, RLS, cuota, Run) contra el
// Postgres local + LocalStorage, SIN Clerk / Upstash / R2 ni ninguna cuenta externa. Es para
// desarrollar y DEMOSTRAR el producto real en la máquina, sin una sola llave.
//
// ⚠️⚠️ SEGURIDAD — ESTO ES UN BYPASS DE AUTENTICACIÓN ⚠️⚠️
// Está DOBLE-gated: solo se activa si NODE_ENV !== 'production' Y AUTOMATA_DEV_AUTH === '1'.
// En producción NUNCA se enciende, aunque alguien ponga la env (el chequeo de NODE_ENV lo
// apaga). Solo sustituye los PUERTOS externos (sesión Clerk → usuario fijo; rate Upstash →
// permitir; storage R2 → local). TODO lo demás del pipeline (membresía viva, assertCan, RLS,
// cuota, kill-switch) corre EXACTAMENTE igual — el modo dev prueba el backend real, no lo apaga.
export const DEV = process.env.NODE_ENV !== "production" && process.env.AUTOMATA_DEV_AUTH === "1";

// Usuario y org fijos del modo dev. DEBEN coincidir con core/scripts/seed-dev-pg.ts (que los
// siembra). El front YA NO clava la org por env: la resuelve de la membresía vía GET /api/yo, que
// en dev devuelve la org sembrada de este DEV_USER (la env NEXT_PUBLIC_AUTOMATA_DEV_ORG quedó obsoleta).
export const DEV_USER = "u_dev";
export const DEV_ORG = "0de00000-0000-0000-0000-0000000de000";

// Versión CLIENTE del bypass (para gatear la UI de Clerk desde componentes cliente):
// AUTOMATA_DEV_AUTH no llega al navegador, así que se usa la env PÚBLICA
// NEXT_PUBLIC_AUTOMATA_DEV_AUTH (ponla junto a AUTOMATA_DEV_AUTH en .env.local). Clerk
// (provider, SignIn, UserButton) se muestra SOLO cuando NO estamos en el bypass de dev.
export const DEV_CLIENTE = process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_AUTOMATA_DEV_AUTH === "1";
export const CLERK_ACTIVO = !DEV_CLIENTE;
