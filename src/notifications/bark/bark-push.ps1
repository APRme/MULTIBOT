<#
  bark-push.ps1 —— 自建 Bark 推送发送脚本（仅 HTTPS 直连，支持推送加密）

  用法：
    .\bark-push.ps1 -Title "标题" -Body "内容"
    .\bark-push.ps1 -Title "标题" -Body "内容" -Group mc
    .\bark-push.ps1 -EnvPath D:\mineflayer\MULTIBOT\.env -Title "标题" -Body "内容"
    .\bark-push.ps1 -Title "标题" -Sound alarm       # 临时换声音，不改文件
    .\bark-push.ps1 -Sweep                           # 试听：依次发一轮候选铃声
    .\bark-push.ps1 -Title "标题" -DryRun            # 空跑：只打印将要发送的内容（已打码），不联网
    .\bark-push.ps1 -Title "标题" -DryRun -ShowPlain # 空跑并显示待加密的明文
    .\bark-push.ps1 -Title "标题" -Plain             # 强制发明文（调试用）
    .\bark-push.ps1 -Title "标题" -Sound ''          # 强制用服务端默认音（1107）

  配置来源：
    默认读取脚本同目录的 .env；用 -EnvPath 可指定其它位置（MULTIBOT 调用时传工作区根的 .env）。
    BARK_URL=https://<域名>:<端口>/<前缀>
    BARK_AUTH_USER=<用户名>
    BARK_AUTH_PASS=<密码>
    BARK_DEVICE_KEY=<22位设备key>
    BARK_CRYPTO_KEY=<16/24/32位 ASCII；留空或删除则发明文>

  加密：
    在 .env 里设置 BARK_CRYPTO_KEY（16/24/32 个 ASCII 字符 = AES-128/192/256）。
    设了就默认加密：AES-CBC + pkcs7 + 每条随机 16 字符 IV；可用 -Plain 临时发明文。
    App 侧必须一致：算法（AES128/192/256）+ 模式 CBC + 填充 pkcs7，否则手机显示 Decryption Failed。
#>

[CmdletBinding()]
param(
  [string]$Title = 'Bark 测试',
  [string]$Body  = '',
  [string]$Group = 'default',
  [string]$Sound,
  [string]$EnvPath,
  [switch]$Sweep,
  [switch]$DryRun,
  [switch]$Plain,
  [switch]$ShowPlain,
  [int]$IntervalSec = 6
)

# ==================== 改这里：默认通知声音 ====================
#   ''          -> 不发 sound 字段，由服务端填默认值 1107（iOS 系统音效）
#   'silence'   -> 完全无声
#   其它值      -> App 内置铃声名（不用带 .caf，服务端会自动补后缀）
#   候选：alarm anticipate bell birdsong bloom calypso chime choo descent electronic
#         fanfare glass gotosleep horn ladder mailsent minuet newmail newsflash noir
#         paymentsuccess shake spell suspense telegraph tiptoes typewriters update
$DefaultSound = ''      # ← 当前选：服务端默认 1107

# -Sweep 试听模式依次发送的铃声（想听别的往这里加）
$SweepSounds = @('alarm','bell','birdsong','chime','minuet','electronic','horn','suspense')
# ============================================================

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 预检失败(配置类问题, 请求根本没发出去): 同样输出脱敏 reason, 便于在 logs/bark.log 里区分排查
function Exit-BarkPreflight([string]$Reason, [string[]]$Messages) {
  foreach ($line in $Messages) { Write-Host $line -ForegroundColor Red }
  Write-Host ("[FAIL] reason={0} elapsed=0.0s sound= crypto=preflight" -f $Reason) -ForegroundColor Red
  exit 1
}

$cfgPath = if ($EnvPath) { $EnvPath } else { Join-Path $PSScriptRoot '.env' }
if (-not (Test-Path -LiteralPath $cfgPath)) {
  Exit-BarkPreflight 'env-missing' @(
    "找不到配置文件: $cfgPath",
    "请把 .env 放到该路径（见 README 第 2、3 节），或用 -EnvPath 指定"
  )
}

$cfg = @{}
Get-Content -LiteralPath $cfgPath |
  Where-Object { $_ -match '=' -and $_ -notmatch '^\s*#' } |
  ForEach-Object {
    $i = $_.IndexOf('=')
    if ($i -gt 0) { $cfg[$_.Substring(0, $i).Trim()] = $_.Substring($i + 1).Trim() }
  }
foreach ($k in @('BARK_URL','BARK_AUTH_USER','BARK_AUTH_PASS','BARK_DEVICE_KEY')) {
  if (-not $cfg[$k]) { Exit-BarkPreflight 'env-incomplete' @("配置项缺失或为空: $k") }
}

$auth = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($cfg.BARK_AUTH_USER):$($cfg.BARK_AUTH_PASS)"))

# ---------- 加密配置 ----------
$CryptoKey     = $cfg['BARK_CRYPTO_KEY']
$CryptoMode    = if ($cfg['BARK_CRYPTO_MODE'])    { $cfg['BARK_CRYPTO_MODE'].ToUpper() }   else { 'CBC' }
$CryptoPadding = if ($cfg['BARK_CRYPTO_PADDING']) { $cfg['BARK_CRYPTO_PADDING'].ToLower() } else { 'pkcs7' }
$CryptoEnabled = $false
$CryptoLabel   = '未启用(明文)'

if ($CryptoKey -and -not $Plain) {
  if ($CryptoKey -match '[^\x20-\x7E]') {
    Exit-BarkPreflight 'crypto-key-invalid' @(
      "BARK_CRYPTO_KEY 含非 ASCII 字符。App 按【字符数】校验长度、却按【UTF-8 字节】当密钥，会解不开。",
      "请改成纯字母数字。"
    )
  }
  $bits = switch ($CryptoKey.Length) { 16 {128} 24 {192} 32 {256} default { 0 } }
  if ($bits -eq 0) {
    Exit-BarkPreflight 'crypto-key-invalid' @("BARK_CRYPTO_KEY 长度必须是 16 / 24 / 32（当前 $($CryptoKey.Length)）")
  }
  if ($CryptoMode -ne 'CBC' -or $CryptoPadding -ne 'pkcs7') {
    Exit-BarkPreflight 'crypto-mode-unsupported' @(
      "本脚本目前只实现了 CBC + pkcs7（当前 mode=$CryptoMode padding=$CryptoPadding）。",
      "请在 Bark App 里选 AES$bits / CBC / pkcs7，并把 .env 的 BARK_CRYPTO_MODE、BARK_CRYPTO_PADDING 改成 CBC、pkcs7。"
    )
  }
  $CryptoEnabled = $true
  $CryptoLabel   = "AES-$bits-CBC/pkcs7"
}

function New-RandomIv {
  # 16 个随机 ASCII 字母数字（App 要求 CBC 的 iv 必须正好 16 个字符）
  $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.ToCharArray()
  $buf = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  -join ($buf | ForEach-Object { $chars[$_ % $chars.Length] })
}

# 失败原因分类(脱敏): 只返回分类标签, 绝不回显异常原文(可能含 URL/路径前缀等秘密)
function Get-BarkFailureReason([object]$err) {
  $ex = $err.Exception
  if (-not $ex) { return 'unknown' }

  if ($ex -is [System.Net.WebException]) {
    if ($ex.Status -eq [System.Net.WebExceptionStatus]::Timeout) { return 'timeout' }
    $resp = $ex.Response
    if ($resp -and $resp.StatusCode) { return "http-$([int]$resp.StatusCode)" }
    switch ($ex.Status) {
      'NameResolutionFailure' { return 'dns-fail' }
      'ConnectFailure'        { return 'connect-fail' }
      'TrustFailure'          { return 'tls-fail' }
      'SecureChannelFailure'  { return 'tls-fail' }
      default                 { return 'web-' + $ex.Status.ToString().ToLower() }
    }
  }

  if ($ex.GetType().Name -match 'HttpResponse') {
    $sc = $ex.Response.StatusCode
    if ($sc) { return "http-$([int]$sc)" }
  }

  $msg = [string]$ex.Message
  if ($msg -match 'timed out|timeout|超时') { return 'timeout' }
  if ($msg -match 'SSL|TLS|trust|certificate') { return 'tls-fail' }
  if ($msg -match 'name or service|resolve|no such host|无法解析') { return 'dns-fail' }
  if ($msg -match 'refused|unreachable|network') { return 'connect-fail' }
  return 'unknown'
}

function ConvertTo-BarkCipher([string]$plainJson) {
  $aes = [Security.Cryptography.Aes]::Create()
  $aes.Mode    = [Security.Cryptography.CipherMode]::CBC
  $aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
  $aes.Key     = [Text.Encoding]::UTF8.GetBytes($CryptoKey)
  $ivStr       = New-RandomIv
  $aes.IV      = [Text.Encoding]::UTF8.GetBytes($ivStr)
  $enc   = $aes.CreateEncryptor()
  $bytes = [Text.Encoding]::UTF8.GetBytes($plainJson)
  $ct    = $enc.TransformFinalBlock($bytes, 0, $bytes.Length)
  $enc.Dispose(); $aes.Dispose()
  return @{ ciphertext = [Convert]::ToBase64String($ct); iv = $ivStr }
}

function Send-Bark {
  param([string]$T, [string]$B, [string]$G, [string]$S)

  $tag = if ($S) { $S } else { '(服务端默认 1107)' }

  # 明文载荷：加密时整段进密文；不加密时直接作为请求体。
  # 注意 level/group/sound 必须放密文里 —— App 的 ciphertext 处理器最先执行，
  # 且会把 userInfo 整个替换成解密后的 map，放在外面的字段会被丢掉。
  $inner = [ordered]@{ title = $T; body = $B; group = $G; level = 'timeSensitive' }
  if ($S) { $inner['sound'] = $S }
  $plainJson = $inner | ConvertTo-Json -Compress

  if ($CryptoEnabled) {
    $enc = ConvertTo-BarkCipher $plainJson
    $payload = [ordered]@{
      device_key = $cfg.BARK_DEVICE_KEY
      ciphertext = $enc.ciphertext
      iv         = $enc.iv
    }
  } else {
    $payload = [ordered]@{
      device_key = $cfg.BARK_DEVICE_KEY
      title      = $T
      body       = $B
      group      = $G
      level      = 'timeSensitive'
    }
    if ($S) { $payload['sound'] = $S }
  }
  $json = $payload | ConvertTo-Json -Compress

  if ($DryRun) {
    # 注意：URL 里的路径前缀和 device_key 都是秘密，输出前都要打码
    $maskedUrl = $cfg.BARK_URL -replace '/[^/]+/?$', '/<PREFIX>'
    Write-Host "[DryRun] POST $maskedUrl/push"
    Write-Host "[DryRun] sound=$tag  crypto=$CryptoLabel"
    Write-Host "[DryRun] $($json.Replace($cfg.BARK_DEVICE_KEY, '<DEVICE_KEY>'))"
    if ($CryptoEnabled) {
      if ($ShowPlain) { Write-Host "[DryRun] 明文(仅本地): $plainJson" }
      else { Write-Host "[DryRun] 明文 $(([Text.Encoding]::UTF8.GetBytes($plainJson)).Length) 字节，未显示（加 -ShowPlain 可看）" }
    }
    return
  }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod -Uri "$($cfg.BARK_URL)/push" -Method Post `
           -Headers @{ Authorization = $auth } `
           -ContentType 'application/json; charset=utf-8' `
           -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 20
    $sw.Stop()
    Write-Host ("[OK/https] sound=$tag  crypto=$CryptoLabel  code=$($r.code)  $($r.message)  elapsed={0:N1}s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    return
  } catch {
    $sw.Stop()
    # 只输出脱敏分类与耗时, 不回显异常原文(可能含 URL/前缀)
    $reason = Get-BarkFailureReason $_
    Write-Host ("[FAIL] reason={0} elapsed={1:N1}s sound=$tag crypto=$CryptoLabel" -f $reason, $sw.Elapsed.TotalSeconds) -ForegroundColor Red
  }
}

if ($Sweep) {
  Write-Host "试听模式：$($SweepSounds.Count) 个铃声，每条间隔 $IntervalSec 秒（crypto=$CryptoLabel）" -ForegroundColor Cyan
  $i = 0
  foreach ($s in $SweepSounds) {
    $i++
    Send-Bark -T "试听 $i/$($SweepSounds.Count)：$s" -B "铃声 = $s" -G 'sound-test' -S $s
    if ($i -lt $SweepSounds.Count) { Start-Sleep -Seconds $IntervalSec }
  }
  Write-Output ""
  Write-Host "试听结束。把满意的那条填进脚本顶部的 `$DefaultSound 即可。" -ForegroundColor Cyan
}
else {
  $use = if ($PSBoundParameters.ContainsKey('Sound')) { $Sound } else { $DefaultSound }
  Send-Bark -T $Title -B $Body -G $Group -S $use
}
