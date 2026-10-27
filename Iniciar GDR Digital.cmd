@echo off
title GDR Digital
cd /d "%~dp0"
if not exist "server\src\index.ts" (
  echo.
  echo  Este arquivo precisa ficar dentro da pasta do projeto GDR Digital.
  echo  Use o atalho "GDR Digital" da Area de Trabalho, ou abra a pasta do projeto e clique em "Iniciar GDR Digital.cmd".
  echo.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  echo Preparando a interface pela primeira vez...
  call npm run build
)
if not exist "data\logs" mkdir "data\logs"
echo.
echo  GDR Digital iniciando. Deixe esta janela aberta (pode minimizar).
echo  No computador: http://localhost:4310
echo  Se o servidor parar, ele reinicia sozinho em 3 segundos.
echo.
rem Abre o navegador so quando o servidor responder (ate ~60 s).
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){ try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4310/health -TimeoutSec 2 | Out-Null; Start-Process 'http://localhost:4310'; break } catch { Start-Sleep 1 } }"
:loop
node --disable-warning=ExperimentalWarning server\src\index.ts
echo [%date% %time%] O servidor parou (codigo %errorlevel%). Reiniciando... >> "data\logs\reinicios.log"
echo  O servidor parou. Reiniciando em 3 segundos...
timeout /t 3 /nobreak >nul
goto loop
