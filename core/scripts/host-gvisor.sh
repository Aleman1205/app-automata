#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Prepara un host Ubuntu para correr el runner CON LA JAULA y verifica que sirve.
#
# Pensado para la VM ARM gratuita de Oracle (Always Free), pero sirve en cualquier Ubuntu:
# Hetzner, DigitalOcean, o el host de producción el día del despliegue.
#
#   ssh oracle 'bash -s' < core/scripts/host-gvisor.sh
#
# Qué hace, en orden: instala Docker y gVisor, registra runsc como runtime, COMPRUEBA que el
# aislamiento es real (comparando kernels), y corre verify:contenedor con la jaula puesta.
#
# La comprobación de kernels no es adorno. Si runsc no queda bien registrado, Docker cae al
# runtime normal SIN AVISAR y los siete checks pasan igual —lo comprobamos en la Mac, donde pasan
# sin jaula alguna—. Sin ese contraste, un verde aquí no significaría nada.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "▶ Host: $(uname -m) · $(. /etc/os-release && echo "$PRETTY_NAME") · $(nproc) núcleos · $(free -g | awk '/^Mem:/{print $2}') GB"

# ── 1. Docker ──
if ! command -v docker >/dev/null 2>&1; then
  echo "▶ Instalando Docker…"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io
  sudo usermod -aG docker "$USER" || true
fi
echo "  docker: $(sudo docker --version)"

# ── 2. gVisor ──
if ! command -v runsc >/dev/null 2>&1; then
  echo "▶ Instalando gVisor…"
  curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq runsc
fi
echo "  runsc: $(runsc --version | head -1)"

# ── 3. Registrar runsc en el daemon ──
# `--runtime` es una bandera del DAEMON, no del cliente: sin este paso, `docker run
# --runtime=runsc` falla con "unknown runtime". (Es exactamente lo que hace imposible probar esto
# en Docker Desktop de macOS: su daemon vive en una VM sellada donde no se puede instalar runsc.)
echo "▶ Registrando runsc como runtime de Docker…"
sudo runsc install
sudo systemctl restart docker
sleep 3
sudo docker info --format '{{json .Runtimes}}' | grep -q runsc \
  || { echo "✗ runsc NO quedó registrado. Sin esto, Docker caería al runtime normal y el test daría un falso verde."; exit 1; }
echo "  runtimes: $(sudo docker info --format '{{json .Runtimes}}')"

# ── 4. La prueba que hace que todo esto signifique algo ──
echo "▶ ¿El aislamiento es real?"
HOST_K=$(uname -r)
JAULA_K=$(sudo docker run --rm --runtime=runsc alpine uname -r)
echo "  kernel del host:  $HOST_K"
echo "  kernel en jaula:  $JAULA_K"
[ "$HOST_K" != "$JAULA_K" ] \
  || { echo "✗ MISMO kernel: no hay jaula. Docker está cayendo a runc y cualquier verde de aquí es mentira."; exit 1; }
echo "  ✓ kernels distintos: gVisor intercepta las syscalls con el suyo"

# ── 5. El runner del producto, bajo la jaula ──
echo "▶ Node + el repo…"
command -v node >/dev/null 2>&1 || { curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null; sudo apt-get install -y -qq nodejs; }
[ -d ~/app-automata ] || git clone -q https://github.com/Aleman1205/app-automata.git ~/app-automata
cd ~/app-automata && git pull -q origin main
cd core && npm install --silent >/dev/null 2>&1

echo "▶ verify:contenedor CON LA JAULA:"
sudo -E env "PATH=$PATH" RUNTIME_PRUEBA=runsc npm run verify:contenedor
