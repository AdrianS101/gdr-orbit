@echo off
title GDR Digital - link publico
cd /d "%~dp0"
if not exist "tools\cloudflared.exe" (
  echo Falta tools\cloudflared.exe. Peça para instalar o link publico.
  pause
  exit /b 1
)
echo.
echo  Criando o link publico do GDR Digital...
echo  O endereco aparece abaixo (https://....trycloudflare.com) e fica salvo em data\logs\link-publico.txt
echo  Deixe esta janela e a do GDR Digital abertas durante a apresentacao.
echo.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4310/health -TimeoutSec 3 | Out-Null } catch { Start-Process -FilePath '%~dp0Iniciar GDR Digital.cmd' -WindowStyle Minimized; Start-Sleep 12 }"
:loop
powershell -NoProfile -Command "& '%~dp0tools\cloudflared.exe' tunnel --no-autoupdate --url http://127.0.0.1:4310 2>&1 | ForEach-Object { $_; if ($_ -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $u=$matches[0]; Set-Content -Path '%~dp0data\logs\link-publico.txt' -Value $u -Encoding utf8; Write-Host ''; Write-Host ('  LINK PUBLICO: ' + $u) -ForegroundColor Green; Write-Host ''; Set-Clipboard $u } }"
echo  O tunel caiu. Reabrindo em 5 segundos (o endereco pode mudar)...
timeout /t 5 /nobreak >nul
goto loop
