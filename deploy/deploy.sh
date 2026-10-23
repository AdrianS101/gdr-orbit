#!/usr/bin/env bash
# Publica a versão atual do GDR Digital no servidor (Git Bash no Windows ou Linux/macOS).
# Uso: deploy/deploy.sh ubuntu@IP-DO-SERVIDOR [chave.pem]
#   - 1ª vez: instala Docker e libera as portas 80/443 no servidor.
#   - Sempre: envia o código, reconstrói e reinicia, mantendo os dados (volume orbit-data).
set -euo pipefail
SERVER="${1:?Informe usuario@ip do servidor}"
KEY="${2:-}"
SSH=(ssh -o StrictHostKeyChecking=accept-new ${KEY:+-i "$KEY"} "$SERVER")
SCP=(scp -o StrictHostKeyChecking=accept-new ${KEY:+-i "$KEY"})
IP="${SERVER#*@}"
DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"
cd "$(dirname "$0")/.."

echo "→ Empacotando o código"
tar --exclude=node_modules --exclude=data --exclude=data-test --exclude=web/dist --exclude=.git --exclude=.claude -czf /tmp/gdr-orbit.tgz .

echo "→ Preparando o servidor (Docker e portas)"
"${SSH[@]}" 'command -v docker >/dev/null || (curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER);
  sudo iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT;
  sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT;
  (command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save) || true;
  mkdir -p ~/gdr-orbit'

echo "→ Enviando"
"${SCP[@]}" /tmp/gdr-orbit.tgz "$SERVER:~/gdr-orbit.tgz"

echo "→ Construindo e iniciando (pode levar alguns minutos na 1ª vez)"
"${SSH[@]}" "cd ~/gdr-orbit && tar -xzf ~/gdr-orbit.tgz && cd deploy && DOMAIN=$DOMAIN sudo -E docker compose up -d --build && sudo docker image prune -f >/dev/null"

echo ""
echo "✓ GDR Digital no ar: https://$DOMAIN"
echo "  Endereços de retorno para cadastrar:"
echo "    Meta:   https://$DOMAIN/api/social/meta/callback"
echo "    Google: https://$DOMAIN/api/drive/callback"
