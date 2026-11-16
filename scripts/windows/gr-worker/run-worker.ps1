# Windows GR Worker 启动脚本（PowerShell，隐藏窗口后台运行）
# 用法：powershell -ExecutionPolicy Bypass -File run-worker.ps1 [-Once]
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { $node = 'node' }

if ($args -contains '-Once') {
    & $node worker.mjs --once
    exit $LASTEXITCODE
}

# 常驻轮询（隐藏窗口）
$p = Start-Process -FilePath $node -ArgumentList @('worker.mjs','--loop') -WorkingDirectory $dir -WindowStyle Hidden -PassThru
Write-Host "tj-gr-worker started (PID $($p.Id))"
