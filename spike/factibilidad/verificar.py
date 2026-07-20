#!/usr/bin/env python3
"""
Verificador de factibilidad — hace de "Verifier" a mano.

Lee el resultado.json que produjo automatizacion.py y lo evalúa contra los 6
criterios de aceptación del caso (spike/casos.js → dashboard-popularidad),
calculando los totales de forma independiente. No confía en el script.

Uso:
    python verificar.py <carpeta_con_resultado.json>
"""

import json
import sys
from pathlib import Path


def main():
    carpeta = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
    d = json.loads((carpeta / "resultado.json").read_text(encoding="utf-8"))
    m, fams, top = d["metricas"], d["familias"], d["top_productos"]

    ok = True

    def check(n, cond, detalle):
        nonlocal ok
        ok = ok and cond
        print(f"  {'✓' if cond else '✗'}  C{n}: {detalle}")

    check(1, isinstance(m, dict) and isinstance(fams, list) and isinstance(top, list),
          f"3 secciones (métricas obj, familias[{len(fams)}], top[{len(top)}])")

    check(2, abs(m["num_productos"] - 448) <= 2,
          f"num_productos = {m['num_productos']} (esperado 448 ±2; NO ~492)")

    check(3, abs(m["ingreso_total"] - 53239430.50) / 53239430.50 < 0.005,
          f"ingreso = {m['ingreso_total']:,.2f} (esperado 53,239,430.50; NO ~106M)")

    check(4, abs(m["utilidad_total"] - 26100916.43) / 26100916.43 < 0.005
             and abs(m["margen_pct"] - 49.0) < 0.2,
          f"utilidad = {m['utilidad_total']:,.2f}, margen = {m['margen_pct']}% (esperado 26.1M / 49.0%)")

    suma_fam = round(sum(f["ingreso"] for f in fams), 2)
    consistente = abs(suma_fam - m["ingreso_total"]) / m["ingreso_total"] < 0.005
    check(5, abs(m["num_familias"] - 44) <= 2 and consistente,
          f"{m['num_familias']} familias; suma familias {suma_fam:,.2f} == total "
          f"{m['ingreso_total']:,.2f} ({'consistente' if consistente else 'INCONSISTENTE'})")

    t0, t1 = top[0], top[1]
    check(6, abs(t0["ingreso"] - 425783) < 2000 and abs(t1["ingreso"] - 410761) < 2000,
          f"top: {t0['producto']} ({t0['ingreso']:,.0f}) · {t1['producto']} ({t1['ingreso']:,.0f})")

    print()
    print("  VEREDICTO:", "✓ APROBADO — 6/6 criterios" if ok else "✗ RECHAZADO")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
