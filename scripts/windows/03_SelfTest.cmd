@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stage25_PO_ACK_Worker_Preview_V2.ps1" -Mode SelfTest
exit /b %ERRORLEVEL%
