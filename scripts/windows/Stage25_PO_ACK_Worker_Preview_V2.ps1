# Stage25 Windows -> Supabase PO DONE ACK sender — PREVIEW V2 (tj_preview only).
# Windows PowerShell 5.1. Manual, one PO at a time. Never starts PAD, IRS, GR or Queue moves.
#
# V2 与 V1 的差异（V1 未修改、不随本包发送）：
#   * 独立配置目录 TJ_PO_ACK_STAGE25_PREVIEW_V2（不覆盖旧配置/会话/Queue）。
#   * schema 固定 tj_preview（ValidateSet + GetConfig fail closed），
#     SendOne 带 Content-Profile / Accept-Profile: tj_preview（V1 缺这两个头 → public 404）。
#   * 修复 refresh 后把原始 access_token 交给 Reveal（期望 DPAPI ciphertext）的缺陷：
#     先 SaveSession，再从保存的 session 解出 DPAPI 密文。
#   * 所有「成功」回执都必须 accepted=true + state=accepted（replayed 可为 true）；
#     accepted=false/replayed=true 绝不当成功；accepted=true+replayed=true 是合法 replay。
#   * 身份（po_id / irs_po_number）无条件核对，不再只在 accepted 分支核对。
#   * 不读取任何 Supabase/密码环境变量；JWT 仅 DPAPI 存储，密码只经 -AsSecureString。
[CmdletBinding()]
param(
    [ValidateSet('List','Configure','Login','SendOne','Status','SelfTest')][string]$Mode='List',
    [string]$POID='',
    [ValidateSet('tj_preview')][string]$Schema='tj_preview',
    [string]$QueueRoot='C:\Users\Administrator\Desktop\operation\PO_Queue'
)
Set-StrictMode -Version 2.0
$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$AckSchema = 'TJ_WINDOWS_PO_QUEUE_DONE_ACK_V1'
$AuthDir = Join-Path $env:LOCALAPPDATA 'TJ_PO_ACK_STAGE25_PREVIEW_V2'
$ConfigPath = Join-Path $AuthDir 'config.json'
$TokenPath = Join-Path $AuthDir 'session.dpapi.json'
function Fail([string]$code) { throw ('NEEDS_REVIEW:'+$code) }
function Val([object]$obj,[string]$key) {
    if ($null -eq $obj) { return $null }
    $p=$obj.PSObject.Properties[$key]
    if ($null -eq $p) { return $null }
    return $p.Value
}
function Str([object]$obj) { if ($null -eq $obj) { return '' }; return ([string]$obj).Trim() }
function Same([string]$a,[string]$b) { return $a.Equals($b,[StringComparison]::OrdinalIgnoreCase) }
function ShaFile([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToUpperInvariant() }
function ReadJson([string]$path) { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop) }
function NeedDir([string]$path) { if (-not (Test-Path -LiteralPath $path -PathType Container)) { [void](New-Item -ItemType Directory -Path $path -Force -ErrorAction Stop) } }
function WriteNewJson([string]$path,[object]$data) {
    if (Test-Path -LiteralPath $path) { Fail ('ALREADY_EXISTS:'+ [IO.Path]::GetFileName($path)) }
    $temp=$path+'.tmp.'+[Guid]::NewGuid().ToString('N')
    $bytes=$Utf8.GetBytes(($data | ConvertTo-Json -Depth 30))
    $file=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    [IO.File]::Move($temp,$path)
}
function SaveConfig([object]$data,[string]$path) {
    $temp=$path+'.tmp.'+[Guid]::NewGuid().ToString('N')
    $bytes=$Utf8.GetBytes(($data | ConvertTo-Json -Depth 15))
    $file=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    if (Test-Path -LiteralPath $path -PathType Leaf) { [IO.File]::Replace($temp,$path,$path+'.previous') }
    else { [IO.File]::Move($temp,$path) }
}
function EventId([string]$id,[string]$hash,[string]$irs) {
    $alg=[Security.Cryptography.SHA256]::Create()
    try { $raw=$Utf8.GetBytes('TJ_QUEUE_DONE_V1|'+$id+'|'+$hash+'|'+$irs); $digest=$alg.ComputeHash($raw) }
    finally { $alg.Dispose() }
    return 'tj.po.queue.done.v1.'+([BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant())
}
function CheckQueueRoot {
    if (-not (Test-Path -LiteralPath $QueueRoot -PathType Container)) { Fail 'QUEUE_ROOT_MISSING' }
    $script:QueueRoot = (Resolve-Path -LiteralPath $QueueRoot).ProviderPath.TrimEnd('\')
    foreach($f in @('Pending','Processing','Done','Failed','NeedsReview','_SaveGuardLedger')) {
       if (-not (Test-Path -LiteralPath (Join-Path $QueueRoot $f) -PathType Container)) { Fail ('QUEUE_FOLDER_MISSING:'+ $f) }
    }
    $script:LedgerDir=Join-Path $QueueRoot '_SaveGuardLedger'
    $script:OutboxDir=Join-Path $LedgerDir '_WebsiteOutbox'
    # On an unused real Queue, Stage23 may not have created _WebsiteOutbox yet.
    # List and Status must be usable before the first Queue Done event.
}
function InRoot([string]$p,[string]$root) {
    if ($p -eq '') { return $false }
    try {
       $full=[IO.Path]::GetFullPath($p)
       $prefix=[IO.Path]::GetFullPath($root).TrimEnd('\')+'\'
       return $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}
function ValidateOne([string]$id) {
    if ($id -cnotmatch '^PO-[0-9]{6}$') { Fail 'PO_ID_REQUIRED_PO_6_DIGITS' }
    if ($id -in @('PO-000005','PO-000011','PO-900003','PO-878329','PO-988881')) { Fail 'HISTORICAL_OR_ISOLATED_ID_BLOCKED' }
    $outpath=Join-Path $OutboxDir ($id+'.done-ack.json')
    if (-not (Test-Path -LiteralPath $outpath -PathType Leaf)) { Fail 'STAGE23_OUTBOX_MISSING' }
    $raw=[IO.File]::ReadAllText($outpath,[Text.Encoding]::UTF8)
    $a=$raw | ConvertFrom-Json -ErrorAction Stop
    if ((Str (Val $a 'schema')) -cne $AckSchema) { Fail 'ACK_SCHEMA_MISMATCH' }
    if ((Str (Val $a 'po_id')) -cne $id -or (Str (Val $a 'business_po_id')) -cne $id) { Fail 'ACK_PO_ID_MISMATCH' }
    if ((Val $a 'queue_done_ack') -ne $true -or (Str (Val $a 'queue_folder')) -cne 'Done') { Fail 'ACK_DONE_PROOF_MISSING' }
    if ((Str (Val $a 'ledger_state')) -cne 'SAVED_VERIFIED_QUEUE_DONE' -or (Str (Val $a 'verification')) -cne 'MANUAL_POSTSAVE_VERIFIED') { Fail 'ACK_UNVERIFIED' }
    if ((Str (Val $a 'callback_state')) -cne 'OUTBOX_NOT_SENT') { Fail 'OUTBOX_STATE_CHANGED_UNEXPECTEDLY' }
    $sha=(Str (Val $a 'source_sha256')).ToUpperInvariant()
    $irs=Str (Val $a 'irs_po_number')
    if ($sha -cnotmatch '^[A-F0-9]{64}$' -or $irs -cnotmatch '^PO[0-9]{8}$') { Fail 'ACK_HASH_OR_IRS_INVALID' }
    if ((Str (Val $a 'queue_done_sha256')).ToUpperInvariant() -cne $sha) { Fail 'ACK_DONE_HASH_MISMATCH' }
    $event=EventId $id $sha $irs
    if ((Str (Val $a 'event_id')) -cne $event) { Fail 'ACK_EVENT_ID_MISMATCH' }
    $ledgerpath=Join-Path $LedgerDir ($id+'.json')
    if (-not (Test-Path -LiteralPath $ledgerpath -PathType Leaf)) { Fail 'LEDGER_MISSING' }
    $l=ReadJson $ledgerpath
    if ((Str (Val $l 'po_id')) -cne $id -or (Str (Val $l 'state')) -cne 'SAVED_VERIFIED_QUEUE_DONE' -or (Str (Val $l 'queue_disposition')) -cne 'DONE_VERIFIED') { Fail 'LEDGER_NOT_DONE' }
    if ((Str (Val $l 'verification')) -cne 'MANUAL_POSTSAVE_VERIFIED' -or (Str (Val $l 'irs_po_number')) -cne $irs -or (Str (Val $l 'source_sha256')).ToUpperInvariant() -cne $sha) { Fail 'LEDGER_ACK_MISMATCH' }
    if ((Str (Val $l 'queue_commit_event_id')) -cne $event) { Fail 'LEDGER_EVENT_MISMATCH' }
    if ((Str (Val $l 'queue_done_verified_at')) -cne (Str (Val $a 'queue_done_verified_at'))) { Fail 'DONE_TIMESTAMP_MISMATCH' }
    $source=Str (Val $l 'source_path')
    if ($source -match '(?i)SYNTHETIC_ROUTER_ROOT_NOT_QUEUE|OFFLINE_TEST_ONLY|TJ_STAGE23_QUEUE_ISOLATED') { Fail 'ISOLATED_SOURCE_BLOCKED' }
    if (-not (InRoot $source $QueueRoot)) { Fail 'LEDGER_SOURCE_NOT_IN_REAL_QUEUE' }
    $expectedPending=Join-Path (Join-Path $QueueRoot 'Pending') ($id+'.xlsx')
    $expectedProcessing=Join-Path (Join-Path $QueueRoot 'Processing') ($id+'.xlsx')
    if (-not (Same $source $expectedPending) -and -not (Same $source $expectedProcessing)) { Fail 'LEDGER_SOURCE_NOT_FROM_VALID_STATE' }
    $done=Join-Path (Join-Path $QueueRoot 'Done') ($id+'.xlsx')
    if (-not (Test-Path -LiteralPath $done -PathType Leaf) -or (ShaFile $done) -cne $sha) { Fail 'DONE_FILE_MISSING_OR_DIFFERENT_SHA' }
    foreach($f in @('Pending','Processing','Failed','NeedsReview')) {
        $p=Join-Path (Join-Path $QueueRoot $f) ($id+'.xlsx')
        if (Test-Path -LiteralPath $p -PathType Leaf) { Fail ('DUPLICATE_QUEUE_FILE_IN:'+ $f) }
    }
    return [pscustomobject]@{ack=$a; raw=$raw; path=$outpath; id=$id; sha=$sha; irs=$irs; event=$event}
}
function GetConfig {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { Fail 'NOT_CONFIGURED_RUN_01_SETUP' }
    $c=ReadJson $ConfigPath
    if ((Str (Val $c 'supabase_url')) -cnotmatch '^https://[a-zA-Z0-9.-]+\.supabase\.co$') { Fail 'CONFIG_URL_INVALID' }
    if ((Str (Val $c 'anon_key')) -eq '' -or (Str (Val $c 'email')) -eq '') { Fail 'CONFIG_INCOMPLETE' }
    # Fail closed：只允许 tj_preview，配置里存了别的 schema 或没存都拒绝。
    if ($Schema -cne 'tj_preview') { Fail 'SCHEMA_NOT_PREVIEW' }
    if ((Str (Val $c 'schema')) -cne 'tj_preview') { Fail 'CONFIG_SCHEMA_NOT_PREVIEW' }
    return $c
}
function SaveSession([object]$s) {
    if ((Str (Val $s 'access_token')) -eq '' -or (Str (Val $s 'refresh_token')) -eq '') { Fail 'AUTH_RESPONSE_MISSING_TOKENS' }
    $seconds=3600
    if ($null -ne (Val $s 'expires_in')) { $seconds=[int](Val $s 'expires_in') }
    $payload=[ordered]@{
        access_dpapi=ConvertFrom-SecureString (ConvertTo-SecureString (Str (Val $s 'access_token')) -AsPlainText -Force)
        refresh_dpapi=ConvertFrom-SecureString (ConvertTo-SecureString (Str (Val $s 'refresh_token')) -AsPlainText -Force)
        expires_utc=[DateTime]::UtcNow.AddSeconds($seconds).ToString('o')
    }
    SaveConfig $payload $TokenPath
}
function Reveal([string]$encrypted) {
    $sec=ConvertTo-SecureString -String $encrypted
    $bstr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}
function GetSession {
    if (-not (Test-Path -LiteralPath $TokenPath -PathType Leaf)) { Fail 'NOT_LOGGED_IN_RUN_02_LOGIN' }
    return (ReadJson $TokenPath)
}
function TokenRequest([object]$c,[string]$kind,[string]$value) {
    $url=(Str (Val $c 'supabase_url')).TrimEnd('/')+'/auth/v1/token?grant_type='+$kind
    $headers=@{apikey=(Str (Val $c 'anon_key'))}
    if ($kind -eq 'refresh_token') { $data=@{refresh_token=$value} }
    else { Fail 'UNEXPECTED_TOKEN_REQUEST' }
    return (Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body ($data | ConvertTo-Json -Compress) -ContentType 'application/json' -TimeoutSec 30 -ErrorAction Stop)
}
function GetAccessToken([object]$c,[bool]$forceRefresh) {
    $s=GetSession
    $valid=([DateTime]::Parse((Str (Val $s 'expires_utc'))).ToUniversalTime() -gt [DateTime]::UtcNow.AddMinutes(2))
    if ($valid -and -not $forceRefresh) { return (Reveal (Str (Val $s 'access_dpapi'))) }
    try {
        $new=TokenRequest $c 'refresh_token' (Reveal (Str (Val $s 'refresh_dpapi')))
        # 先落盘（DPAPI），再从保存后的 session 解出 access token。
        # 绝不能把 $new 里的原始 token 交给 Reveal（V1 缺陷 → 必然失败）。
        SaveSession $new
        $saved=GetSession
        return (Reveal (Str (Val $saved 'access_dpapi')))
    }
    catch { Fail 'TOKEN_REFRESH_FAILED_RUN_LOGIN_AGAIN' }
}
function Resolve-AckResponse([object]$resp,[string]$poId,[string]$irs) {
    if ($null -eq $resp) { return [pscustomobject]@{Ok=$false;Code='EMPTY_RESPONSE';Result='REJECTED'} }
    if ($resp -is [array]) {
        if ($resp.Count -ne 1) { return [pscustomobject]@{Ok=$false;Code='ARRAY_NOT_ONE_RESULT';Result='REJECTED'} }
        $resp=$resp[0]
    }
    if ($null -eq $resp -or $resp -isnot [pscustomobject]) {
        return [pscustomobject]@{Ok=$false;Code='INVALID_RESPONSE_SHAPE';Result='REJECTED'}
    }
    $accepted=(Val $resp 'accepted') -eq $true
    $replayed=(Val $resp 'replayed') -eq $true
    $rejected=(Val $resp 'rejected') -eq $true
    $state=Str (Val $resp 'state')
    $code=Str (Val $resp 'code')
    if ($rejected) { return [pscustomobject]@{Ok=$false;Code=$code;Result='REJECTED'} }
    # accepted=false（含 replayed=true）绝不是成功；replayed 只有在 accepted=true 时才是合法 replay。
    if (-not $accepted) { return [pscustomobject]@{Ok=$false;Code=$(if($code){$code}else{'NOT_ACCEPTED'});Result='REJECTED'} }
    if ($state -cne 'accepted') { return [pscustomobject]@{Ok=$false;Code=$(if($code){$code}else{'STATE_NOT_ACCEPTED'});Result='REJECTED'} }
    # 身份无条件核对：无论 accepted/replayed，返回的 PO / IRS 号都必须一致。
    $identityOk = ((Str (Val $resp 'po_id')) -ceq $poId) -and ((Str (Val $resp 'irs_po_number')) -ceq $irs)
    if (-not $identityOk) { return [pscustomobject]@{Ok=$false;Code='IDENTITY_MISMATCH';Result='REJECTED'} }
    if ($replayed) { return [pscustomobject]@{Ok=$true;Code='REPLAYED';Result='ACCEPTED_REPLAY'} }
    return [pscustomobject]@{Ok=$true;Code='';Result='ACCEPTED'}
}
function SendOne([string]$id) {
    if ($QueueRoot -match '(?i)TEMP|STAGE23_QUEUE_ISOLATED|OFFLINE_TEST_ONLY|SYNTHETIC') { Fail 'REAL_SEND_REQUIRES_REAL_QUEUE_ROOT' }
    $proof=ValidateOne $id
    $receipts=Join-Path $LedgerDir '_WebsiteAckReceipts'
    $audit=Join-Path $LedgerDir '_WebsiteAckAudit'
    NeedDir $receipts; NeedDir $audit
    $receipt=Join-Path $receipts ($id+'.ack-receipt.json')
    $reject=Join-Path $audit ($id+'.rejected.json')
    $uncertain=Join-Path $audit ($id+'.transport-uncertain.json')
    if (Test-Path -LiteralPath $receipt) { Write-Host 'ALREADY_RECORDED=True | NO_NETWORK_REPLAY=True'; exit 0 }
    if (Test-Path -LiteralPath $reject) { Fail 'PRIOR_WEBSITE_REJECTION_RECONCILE_FIRST' }
    if (Test-Path -LiteralPath $uncertain) { Fail 'PRIOR_TRANSPORT_UNCERTAIN_RECONCILE_FIRST_NO_BLIND_RETRY' }
    $c=GetConfig
    $token=GetAccessToken $c $false
    Write-Host ('READY_FOR_REAL_WEBSITE_POST='+$id+' | IRS='+$proof.irs+' | SHA='+$proof.sha+' | SCHEMA='+$Schema)
    Write-Host ('RPC='+((Str (Val $c 'supabase_url')).TrimEnd('/')+'/rest/v1/rpc/tj_po_ack_ingest'))
    Write-Host 'This sends WEBSITE status update only. It does NOT create IRS PO, move Queue, or post GR.'
    $answer=Read-Host ('Type SEND-ACK-'+$id+' for ONE authenticated Website call')
    if ($answer -cne ('SEND-ACK-'+$id)) { Fail 'REAL_WEBSITE_POST_NOT_AUTHORIZED' }
    # Create exactly one durable attempt marker BEFORE network. The marker is intentionally not
    # a successful receipt; no automatic retry is permitted after possible network ambiguity.
    $attempt=Join-Path $audit ($id+'.send-attempt.json')
    if (Test-Path -LiteralPath $attempt) { Fail 'PRIOR_SEND_ATTEMPT_RECONCILIATION_REQUIRED' }
    WriteNewJson $attempt ([ordered]@{po_id=$id;event_id=$proof.event;source_sha256=$proof.sha;irs_po_number=$proof.irs;attempted_at=[DateTimeOffset]::Now.ToString('o');result='ATTEMPT_STARTED_BEFORE_NETWORK'})
    $uri=(Str (Val $c 'supabase_url')).TrimEnd('/')+'/rest/v1/rpc/tj_po_ack_ingest'
    # Preview 必须显式声明 schema：缺这两个头会走 public → 404 / 写错库。
    $headers=@{apikey=(Str (Val $c 'anon_key'));Authorization=('Bearer '+$token);'Content-Profile'=$Schema;'Accept-Profile'=$Schema}
    $body='{"p_payload":'+$proof.raw+'}'
    try {
        $response=Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 40 -ErrorAction Stop
    } catch {
        $code='UNKNOWN'
        try { if ($null -ne $_.Exception.Response) { $code=[string]([int]$_.Exception.Response.StatusCode) } } catch { }
        WriteAudit $id 'transport-uncertain' ([ordered]@{po_id=$id;event_id=$proof.event;at=[DateTimeOffset]::Now.ToString('o');http_status=$code;status='NEEDS_REVIEW_TRANSPORT_UNCERTAIN';reason='UNKNOWN_IF_SERVER_ACCEPTED_DO_NOT_BLIND_RETRY'})
        Fail ('WEBSITE_CALL_FAILED_OR_UNCERTAIN_HTTP_'+$code)
    }
    $verdict=Resolve-AckResponse $response $id $proof.irs
    if (-not $verdict.Ok) {
        WriteAudit $id 'rejected' ([ordered]@{po_id=$id;event_id=$proof.event;at=[DateTimeOffset]::Now.ToString('o');status='NEEDS_REVIEW';server_code=$verdict.Code;server_response=$response})
        Fail ('WEBSITE_ACK_REJECTED_OR_AMBIGUOUS:'+ $verdict.Code)
    }
    WriteNewJson $receipt ([ordered]@{schema='TJ_WINDOWS_PO_ACK_RECEIPT_V1';po_id=$id;event_id=$proof.event;irs_po_number=$proof.irs;source_sha256=$proof.sha;recorded_at=[DateTimeOffset]::Now.ToString('o');result=$verdict.Result;server_response=$response})
    Write-Host ('WEBSITE_ACK_RECORDED=True | RESULT='+$verdict.Result+' | PO='+$id+' | IRS='+$proof.irs)
    Write-Host ('RECEIPT='+$receipt)
    Write-Host 'NO_IRS_SAVE=True | NO_QUEUE_MOVE=True | NO_GOODS_RECEIVE=True'
}
function StatusOne([string]$id) {
    if ($id -cnotmatch '^PO-[0-9]{6}$') { Fail 'PO_ID_FORMAT' }
    $accepted=Join-Path (Join-Path $LedgerDir '_WebsiteAckReceipts') ($id+'.ack-receipt.json')
    $review=Join-Path (Join-Path $LedgerDir '_WebsiteAckAudit') ($id+'.rejected.json')
    $uncertain=Join-Path (Join-Path $LedgerDir '_WebsiteAckAudit') ($id+'.transport-uncertain.json')
    if (Test-Path -LiteralPath $accepted -PathType Leaf) { Write-Host ('STATUS=WEBSITE_ACK_RECEIPT_RECORDED | PO='+$id); return }
    if (Test-Path -LiteralPath $review -PathType Leaf) { Write-Host ('STATUS=NEEDS_REVIEW_WEBSITE_REJECTED | PO='+$id); return }
    if (Test-Path -LiteralPath $uncertain -PathType Leaf) { Write-Host ('STATUS=NEEDS_REVIEW_TRANSPORT_UNCERTAIN | PO='+$id); return }
    $ack=Join-Path (Join-Path $LedgerDir '_WebsiteOutbox') ($id+'.done-ack.json')
    if (Test-Path -LiteralPath $ack -PathType Leaf) { Write-Host ('STATUS=OUTBOX_PENDING | PO='+$id) }
    else { Write-Host ('STATUS=NO_OUTBOX | PO='+$id) }
}
function WriteAudit([string]$id,[string]$suffix,[object]$obj) {
    $dir=Join-Path $LedgerDir '_WebsiteAckAudit'
    NeedDir $dir
    $dest=Join-Path $dir ($id+'.'+$suffix+'.json')
    if (Test-Path -LiteralPath $dest -PathType Leaf) {
        Write-Host ('AUDIT_ALREADY_EXISTS='+$dest)
    } else { WriteNewJson $dest $obj; Write-Host ('AUDIT_FILE='+$dest) }
}
function AssertVerdict([string]$name,[object]$resp,[string]$expected,[string]$po,[string]$irs) {
    $v=Resolve-AckResponse $resp $po $irs
    if ($v.Result -cne $expected) { throw ('SELFTEST_VERDICT_FAILED:'+$name+' expected='+$expected+' actual='+$v.Result) }
}
function SelfTest {
    # 1) Stage23 确定性 event_id 公式（V1 已验证过的用户证据）
    $id='PO-988881'; $irs='PO99999999'; $hash='C3A294DE29B3C6C6F11D7D4A87A8663567F871205BA99A60CFFA908CCF03BF21'
    $event=EventId $id $hash $irs
    if ($event -cne 'tj.po.queue.done.v1.15ad370294b59d4fa8ea47b6f85210ae9d40d4b6c71e8d0a272da5cdfc0ea2a5') { throw 'SELFTEST_EVENT_ID_NOT_EQUAL_STAGE23_USER_PROOF' }
    $payload=[ordered]@{schema=$AckSchema; event_id=$event;po_id=$id;business_po_id=$id;source_sha256=$hash;irs_po_number=$irs;verification='MANUAL_POSTSAVE_VERIFIED';queue_done_ack=$true;queue_done_sha256=$hash;queue_folder='Done';ledger_state='SAVED_VERIFIED_QUEUE_DONE';callback_state='OUTBOX_NOT_SENT'}
    $wrapped='{"p_payload":'+($payload | ConvertTo-Json -Depth 16 -Compress)+'}'
    $obj=$wrapped | ConvertFrom-Json
    if ((Str (Val (Val $obj 'p_payload') 'event_id')) -cne $event) { throw 'SELFTEST_WRAPPER' }
    # 2) 服务端响应判定表（纯逻辑，不联网）：覆盖 V1 误判的两个分支
    $po='PO-000101'; $irs2='PO26000101'
    AssertVerdict 'accepted' ([pscustomobject]@{accepted=$true;replayed=$false;rejected=$false;state='accepted';code=$null;po_id=$po;irs_po_number=$irs2}) 'ACCEPTED' $po $irs2
    AssertVerdict 'accepted_replay' ([pscustomobject]@{accepted=$true;replayed=$true;rejected=$false;state='accepted';code='PO_ACK_REPLAY';po_id=$po;irs_po_number=$irs2}) 'ACCEPTED_REPLAY' $po $irs2
    AssertVerdict 'replay_without_accept' ([pscustomobject]@{accepted=$false;replayed=$true;rejected=$false;state='accepted';code=$null;po_id=$po;irs_po_number=$irs2}) 'REJECTED' $po $irs2
    AssertVerdict 'rejected' ([pscustomobject]@{accepted=$false;replayed=$false;rejected=$true;state='needs_review';code='PO_ACK_SHA_MISMATCH';po_id=$po;irs_po_number=$irs2}) 'REJECTED' $po $irs2
    AssertVerdict 'state_not_accepted' ([pscustomobject]@{accepted=$true;replayed=$false;rejected=$false;state='needs_review';code=$null;po_id=$po;irs_po_number=$irs2}) 'REJECTED' $po $irs2
    AssertVerdict 'identity_mismatch' ([pscustomobject]@{accepted=$true;replayed=$false;rejected=$false;state='accepted';code=$null;po_id='PO-999999';irs_po_number=$irs2}) 'REJECTED' $po $irs2
    AssertVerdict 'irs_mismatch_replay' ([pscustomobject]@{accepted=$true;replayed=$true;rejected=$false;state='accepted';code=$null;po_id=$po;irs_po_number='PO26000999'}) 'REJECTED' $po $irs2
    AssertVerdict 'empty_response' $null 'REJECTED' $po $irs2
    AssertVerdict 'array_two_results' @([pscustomobject]@{accepted=$true},[pscustomobject]@{accepted=$true}) 'REJECTED' $po $irs2
    Write-Host 'STAGE25_PREVIEW_V2_OFFLINE_PASS=True | ACK_VERDICT_TABLE=True | RPC_WRAPPER_P_PAYLOAD=True | STAGE23_EVENT_FORMULA=True | SCHEMA=tj_preview | NO_NETWORK=True'
}
Write-Host ('=== STAGE25 PREVIEW V2 WINDOWS PO ACK WORKER | Mode='+$Mode+' | Schema='+$Schema+' ===')
if ($Mode -eq 'SelfTest') { SelfTest; exit 0 }
if ($Mode -eq 'Configure') {
    NeedDir $AuthDir
    Write-Host 'Only for the isolated PREVIEW environment (tj_preview). Do not point this at production/public.'
    Write-Host 'Get the six values by running scripts/show-preview-connection.py from a real SSH terminal.'
    $url=(Read-Host 'Supabase URL (https://xxxxx.supabase.co)').Trim().TrimEnd('/')
    $anon=(Read-Host 'Supabase publishable/anon API key').Trim()
    $email=(Read-Host 'Dedicated Auth worker email').Trim()
    if ($url -cnotmatch '^https://[a-zA-Z0-9.-]+\.supabase\.co$' -or $anon -eq '' -or $email -notmatch '^\S+@\S+\.\S+$') { Fail 'CONFIG_INPUT_INVALID' }
    SaveConfig ([ordered]@{supabase_url=$url;anon_key=$anon;email=$email;schema='tj_preview'}) $ConfigPath
    Write-Host ('CONFIG_SAVED='+$ConfigPath)
    Write-Host 'SCHEMA_FIXED=tj_preview | NEXT=02_LOGIN_ONCE.cmd'
    exit 0
}
if ($Mode -eq 'Login') {
    $c=GetConfig
    $sec=Read-Host ('Password for '+(Str (Val $c 'email'))) -AsSecureString
    $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $pw=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    try {
       $data=@{email=(Str (Val $c 'email'));password=$pw}
       $headers=@{apikey=(Str (Val $c 'anon_key'))}
       $url=(Str (Val $c 'supabase_url')).TrimEnd('/')+'/auth/v1/token?grant_type=password'
       $s=Invoke-RestMethod -Uri $url -Method Post -Headers $headers -Body ($data|ConvertTo-Json -Compress) -ContentType 'application/json' -TimeoutSec 30 -ErrorAction Stop
       SaveSession $s
    } catch { Fail 'LOGIN_FAILED_CHECK_WORKER_ACCOUNT_OR_AUTH_DEPLOYMENT' }
    finally { $pw=$null; $data=$null }
    Write-Host 'LOGIN_OK=True | SESSION_STORED_DPAPI_FOR_THIS_WINDOWS_USER=True | JWT_NOT_PRINTED=True | SCHEMA=tj_preview'
    exit 0
}
CheckQueueRoot
if ($Mode -eq 'List') {
    $files=@()
    if (Test-Path -LiteralPath $OutboxDir -PathType Container) {
        $files=@(Get-ChildItem -LiteralPath $OutboxDir -Filter 'PO-*.done-ack.json' -File -ErrorAction Stop)
    }
    Write-Host ('OUTBOX_COUNT='+$files.Count+' | ACTUAL_WEBSITE_SEND=False | SCHEMA=tj_preview')
    foreach($file in $files) {
       $id=$file.Name.Substring(0,9)
       try { $q=ValidateOne $id; Write-Host ('READY='+$id+' | IRS='+$q.irs); StatusOne $id }
       catch { Write-Host ('NEEDS_REVIEW='+$id+' | '+[string]$_) }
    }
    if ($files.Count -eq 0) { Write-Host 'NO_REAL_OUTBOX_YET: WAIT_FOR_NEW_WEBSITE_PO_WITH_VERIFIED_QUEUE_DONE' }
    exit 0
}
if ($Mode -eq 'Status') { StatusOne $POID; exit 0 }
if ($Mode -ne 'SendOne') { Fail 'UNKNOWN_MODE' }
if ($POID -eq '') { Fail 'POID_REQUIRED_FOR_SENDONE' }
SendOne $POID
