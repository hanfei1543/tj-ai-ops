# Embedded into TJ-AI-Ops.bat at build time; no extra .ps1 is needed on Windows.
$ErrorActionPreference = 'Stop'
$node = 'C:\Program Files\nodejs\node.exe'
$bridge = 'C:\irs\bridge.js'
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'
$key = Join-Path $env:USERPROFILE '.ssh\irs_tunnel'
$sessionKey = Join-Path $env:USERPROFILE '.ssh\hermes-xeon'
foreach ($file in @($node, $bridge, $ssh, $key, $sessionKey)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw ('Required file not found: ' + $file)
    }
}

$listener = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue)
if ($listener.Count -eq 0) {
    Start-Process -FilePath $node -ArgumentList @($bridge) -WorkingDirectory 'C:\irs' -WindowStyle Hidden | Out-Null
}
$ready = $false
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
        $response = Invoke-RestMethod -Uri 'http://127.0.0.1:9000' -Method Post -ContentType 'application/json' -Body '{"args":["version"]}' -TimeoutSec 4
        $version = $response.out | ConvertFrom-Json
        if ($response.ok -and $version.ok -and $version.command -eq 'version' -and $version.data.os -eq 'windows') {
            $ready = $true
            break
        }
    } catch {
        # The bridge may still be starting; do not print business data.
    }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    throw 'The local IRS bridge did not pass its version check. Session not opened.'
}

$tunnels = @(Get-CimInstance Win32_Process -Filter "Name='ssh.exe'" | Where-Object {
    $_.CommandLine -like '*irs_tunnel*' -and
    $_.CommandLine -like '*127.0.0.1:9000:127.0.0.1:9000*' -and
    $_.CommandLine -like '*hermes@167.104.103.163*'
})
if ($tunnels.Count -eq 0) {
    $quotedKey = '"' + $key + '"'
    $arguments = '-N -i ' + $quotedKey + ' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:9000:127.0.0.1:9000 hermes@167.104.103.163'
    $tunnel = Start-Process -FilePath $ssh -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 2
    if ($tunnel.HasExited) {
        throw 'The SSH tunnel exited. Check connection/key/host verification or an existing VPS port 9000 listener.'
    }
    Write-Host 'IRS bridge checked; SSH tunnel process started. VPS connectivity is checked from the session.'
} else {
    Write-Host 'IRS bridge checked; reusing existing SSH tunnel process. VPS connectivity is checked from the session.'
}
