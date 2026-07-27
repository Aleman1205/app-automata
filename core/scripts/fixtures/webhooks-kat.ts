// ─────────────────────────────────────────────────────────────────────────────
// Vector de conformidad OFICIAL y PÚBLICO del estándar standard-webhooks
// (github.com/standard-webhooks/standard-webhooks): el "Known-Answer-Test" que el
// propio spec publica para que cualquier implementación valide su HMAC. NO es una
// credencial de ninguna cuenta — es un dato público por diseño. Se aísla aquí (fuera
// del script de test) y se marca con `gitleaks:allow` para que el escáner de secretos
// no lo confunda con una llave real.
// ─────────────────────────────────────────────────────────────────────────────

export const KAT_STANDARD_WEBHOOKS = {
  payload: '{"test": 2432232314}',
  headers: {
    "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
    "webhook-timestamp": "1614265330",
    "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  },
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", // gitleaks:allow — vector público del spec, no un secreto real
  timestampMs: 1614265330 * 1000, // el ts del vector, en ms
} as const;
