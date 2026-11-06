@echo off
cd /d "%~dp0"
start "irs-bridge" /min "C:\Program Files\nodejs\node.exe" bridge.js
timeout /t 3 /nobreak >nul
"C:\Windows\System32\OpenSSH\ssh.exe" -i "%USERPROFILE%\.ssh\irs_tunnel" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:9000:127.0.0.1:9000 hermes@167.104.103.163 -N
