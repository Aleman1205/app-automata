import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Topbar } from "@/components/topbar";
import { Pie } from "@/components/pie";
import { ScrollSuave } from "@/components/scroll-suave";
import { MARCA, ESLOGAN } from "@/lib/marca";

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

const plex = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: `${MARCA} — ${ESLOGAN}`,
  description:
    "Describe tu proceso una vez. Un equipo de agentes lo convierte en una automatización lista para usar desde tu portafolio.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es" className={`${archivo.variable} ${plex.variable}`}>
      <body className="grano bg-crema font-sans text-tinta antialiased">
        <ScrollSuave />
        <Topbar />
        <main className="min-h-screen">{children}</main>
        <Pie />
      </body>
    </html>
  );
}
