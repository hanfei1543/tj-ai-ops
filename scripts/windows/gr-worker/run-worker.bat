@echo off
rem Windows GR Worker 启动脚本（后台隐藏窗口运行，开机自启请用任务计划程序指向本脚本）
rem 用法：双击运行；或命令行 run-worker.bat（--once 跑一轮后退出）
setlocal
cd /d "%~dp0"

set NODE=C:\Program Files\nodejs\node.exe
if not exist "%NODE%" set NODE=node

if "%1"=="--once" (
  "%NODE%" worker.mjs --once
  exit /b %errorlevel%
)

rem 常驻轮询（隐藏窗口）
start "tj-gr-worker" /min "%NODE%" worker.mjs --loop
exit /b 0
