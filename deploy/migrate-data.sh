#!/usr/bin/env bash
# Copia os dados do PC (marcas, projetos, arquivos, chaves) para o servidor. Rodar uma vez, antes de usar o servidor.
# Uso: deploy/migrate-data.sh ubuntu@IP-DO-SERVIDOR [chave.pem]
# Atenção: substitui os dados que estiverem no servidor.
set -euo pipefail
SERVER="${1:?Informe usuario@ip do servidor}"
KEY="${2:-}"
SSH=(ssh ${KEY:+-i "$KEY"} "$SERVER")
cd "$(dirname "$0")/.."
echo "→ Empacotando data/ (sem os modelos de transcrição, que o servidor baixa sozinho)"
tar --exclude=data/models --exclude=data/tmp -czf /tmp/gdr-data.tgz data
scp ${KEY:+-i "$KEY"} /tmp/gdr-data.tgz "$SERVER:~/gdr-data.tgz"
"${SSH[@]}" 'cd ~/gdr-orbit/deploy && sudo docker compose stop orbit &&
  VOL=$(sudo docker volume inspect -f "{{.Mountpoint}}" deploy_orbit-data) &&
  sudo tar -xzf ~/gdr-data.tgz -C /tmp && sudo cp -a /tmp/data/. "$VOL"/ && sudo rm -rf /tmp/data ~/gdr-data.tgz &&
  sudo docker compose start orbit'
echo "✓ Dados migrados."
