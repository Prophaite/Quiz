@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Mode Internet : les telephones peuvent se connecter depuis n'importe quel reseau (4G, autre Wi-Fi).
rem Necessite cloudflared (gratuit, sans compte) : winget install --id Cloudflare.cloudflared
start "" http://localhost:3000/host
node server.js --internet
pause
