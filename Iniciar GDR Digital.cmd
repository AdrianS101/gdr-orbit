@echo off
title GDR Digital
cd /d "%~dp0"
if not exist "web\dist\index.html" (
  echo Preparando a interface pela primeira vez...
  call npm run build
)
if not exist "data\logs" mkdir "data\logs"
echo.
echo  GDR Digital rodando. Deixe esta janela aberta (pode minimizar).
echo  No computador: http://localhost:4310
echo  Se o servidor parar, ele reinicia sozinho em 3 segundos.
echo.
start "" http://localhost:4310
:loop
node --disable-warning=ExperimentalWarning server\src\index.ts
echo [%date% %time%] O servidor parou (codigo %errorlevel%). Reiniciando... >> "data\logs\reinicios.log"
echo  O servidor parou. Reiniciando em 3 segundos...
timeout /t 3 /nobreak >nul
goto loop
