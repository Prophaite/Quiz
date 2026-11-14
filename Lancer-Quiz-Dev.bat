@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Mode dev : comme Lancer-Quiz-Internet.bat, mais la page de gestion s'ouvre en mode dev.
rem Dans ce mode, les joueurs inscrits avec un pseudo terminé par #dev ont un badge "test".
rem Necessite cloudflared (gratuit, sans compte) : winget install --id Cloudflare.cloudflared
start "" "http://localhost:3000/host?dev=1"
node server.js --internet
pause
