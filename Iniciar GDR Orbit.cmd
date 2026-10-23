@echo off
title GDR Orbit
cd /d "%~dp0"
if not exist "web\dist\index.html" (
  echo Preparando a interface pela primeira vez...
  call npm run build
)
echo.
echo  GDR Orbit iniciando. Deixe esta janela aberta (pode minimizar).
echo  No computador: http://localhost:4310
echo.
start "" http://localhost:4310
call npm start
pause
