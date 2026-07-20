import { ImageResponse } from "next/og";

// Imagen que aparece al compartir el link (WhatsApp, Slack, X…).
export const alt = "Automata — Tu proceso, construido por agentes.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#EFE8D8",
          padding: "80px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Etiqueta superior */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "14px",
            color: "#7C6F5C",
            fontSize: "26px",
            letterSpacing: "6px",
            textTransform: "uppercase",
          }}
        >
          <div
            style={{
              width: "14px",
              height: "14px",
              borderRadius: "999px",
              background: "#FF4D00",
            }}
          />
          Plataforma de automatización
        </div>

        {/* Marca + eslogan */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              fontSize: "150px",
              fontWeight: 900,
              letterSpacing: "-4px",
              color: "#1D1710",
              lineHeight: 1,
            }}
          >
            Automata
            <span style={{ color: "#FF4D00" }}>.</span>
          </div>
          <div
            style={{
              marginTop: "28px",
              fontSize: "44px",
              fontWeight: 700,
              color: "#1D1710",
              maxWidth: "900px",
              lineHeight: 1.15,
            }}
          >
            Describe tu proceso. Nosotros lo convertimos en software.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
