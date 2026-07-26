import type { NextConfig } from "next";

// Next 16: `next build` ya no corre ESLint (la opción eslint.* fue eliminada).
// TypeScript sí bloquea el build — intencional.
const nextConfig: NextConfig = {
  // automata-core es un paquete TS-only (sin build): Next lo transpila. Sus imports usan
  // extensión .ts (para tsx/Node), que tsconfig acepta con allowImportingTsExtensions.
  transpilePackages: ["automata-core"],
};

export default nextConfig;
