# Windows GR Worker 部署只读检查（单次运行，不启动常驻 Worker、不开机自启）
# 用法：powershell -ExecutionPolicy Bypass -File verify-deploy.ps1
# 只读：不写入队列、不启动 worker、不触发任何 IRS 操作；仅打印环境就绪情况。
$ErrorActionPreference = 'Continue'
Write-Host "=== TJ GR Worker 部署只读检查 ==="

# 1) Node
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $node = $nodeCmd.Source; Write-Host "[OK] node: $node" }
  else { Write-Host "[FAIL] 未找到 node.exe（需安装 Node.js 18+）" }
} else {
  $v = & $node --version 2>$null
  Write-Host "[OK] node $v"
}

# 2) .env（只确认存在，不打印内容）
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path -LiteralPath (Join-Path $dir '.env')) { Write-Host "[OK] .env 存在（凭据不打印）" }
else { Write-Host "[WARN] .env 不存在（先复制 config.example.env 填值）" }

# 3) 队列目录
$queue = 'C:\Users\Administrator\Desktop\operation\GR_Queue'
if (Test-Path -LiteralPath $queue) {
  foreach ($sub in 'Pending','Processing','Done','Failed','NeedsReview') {
    $p = Join-Path $queue $sub
    if (Test-Path -LiteralPath $p) { Write-Host "[OK] $p" } else { Write-Host "[WARN] $p 不存在（worker 会自动创建）" }
  }
} else { Write-Host "[WARN] $queue 不存在（worker 会自动创建）" }

# 4) bridge.js 版本（是否含 GR_Queue 写白名单）
$bridge = 'C:\irs\bridge.js'
if (Test-Path -LiteralPath $bridge) {
  $content = Get-Content -LiteralPath $bridge -Raw
  if ($content -match 'GR_Queue') { Write-Host "[OK] bridge.js 含 GR_Queue 写白名单" }
  else { Write-Host "[WARN] bridge.js 不含 GR_Queue 白名单（需替换为 ZIP 内新版，见部署步骤）" }
} else { Write-Host "[WARN] 未找到 C:\irs\bridge.js" }

# 5) Pending 里待处理任务数（只读）
$pendingDir = Join-Path $queue 'Pending'
if (Test-Path -LiteralPath $pendingDir) {
  $n = (Get-ChildItem -LiteralPath $pendingDir -Filter 'task-*.json' -ErrorAction SilentlyContinue).Count
  Write-Host "[INFO] Pending 待处理任务数：$n"
}

Write-Host "=== 检查完成（本脚本只读，不启动 Worker）==="
