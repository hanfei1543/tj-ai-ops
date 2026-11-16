@echo off
setlocal
if "%~1"=="" (
  echo POID_REQUIRED: usage 04_SendOne_POID.cmd PO-000123
  exit /b 2
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stage25_PO_ACK_Worker_Preview_V2.ps1" -Mode SendOne -POID "%~1"
exit /b %ERRORLEVEL%
