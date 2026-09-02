param(
  [string]$ConfigPath = "multibot.config.json",
  [int]$RestartDelaySeconds = 15,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

# Node heap/GC tuning for high-traffic areas; write a heap snapshot before OOM for analysis.
$env:NODE_OPTIONS = "--max-old-space-size=4096 --max-semi-space-size=512 --heapsnapshot-near-heap-limit=2"

function Resolve-ConfigPath {
  param(
    [string]$PathText
  )

  if ([System.IO.Path]::IsPathRooted($PathText)) {
    return $PathText
  }

  return Join-Path $PSScriptRoot $PathText
}

$resolvedConfigPath = Resolve-ConfigPath -PathText $ConfigPath
$indexPath = Join-Path $PSScriptRoot "index.js"

if (-not (Test-Path -LiteralPath $indexPath)) {
  Write-Error "[MULTIBOT] index.js not found: $indexPath"
  exit 1
}

if (-not (Test-Path -LiteralPath $resolvedConfigPath)) {
  Write-Error "[MULTIBOT] config not found: $resolvedConfigPath"
  exit 1
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  Write-Error "[MULTIBOT] node was not found in PATH"
  exit 1
}

Write-Host "[MULTIBOT] Starting..."
Write-Host "[MULTIBOT] Config: $resolvedConfigPath"

$cpuProfileOnExit = $false
try {
  $configObject = Get-Content -LiteralPath $resolvedConfigPath -Raw | ConvertFrom-Json
  $cpuProfileOnExit = $configObject.diagnostics.cpuProfileOnExit -eq $true
} catch {
  Write-Warning "[MULTIBOT] Failed to inspect diagnostics.cpuProfileOnExit; Node config validation will report the error."
}

$nodeArguments = @($indexPath, $resolvedConfigPath)
if ($cpuProfileOnExit) {
  $profileDirectory = Join-Path $PSScriptRoot "profiles\cpu"
  New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
  $profileName = "MULTIBOT-{0}.cpuprofile" -f (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssfffZ")
  $nodeArguments = @(
    "--cpu-prof",
    "--cpu-prof-dir=$profileDirectory",
    "--cpu-prof-name=$profileName",
    $indexPath,
    $resolvedConfigPath
  )
  Write-Host "[MULTIBOT] CPU profile enabled: $(Join-Path $profileDirectory $profileName)"
}

while ($true) {
  & $nodeCommand.Source @nodeArguments
  $exitCode = $LASTEXITCODE

  if ($exitCode -eq 0) {
    Write-Host "[MULTIBOT] Process exited normally."
    exit 0
  }

  Write-Warning "[MULTIBOT] Process exited with code $exitCode."

  if ($NoRestart) {
    exit $exitCode
  }

  Write-Host "[MULTIBOT] Restarting in $RestartDelaySeconds seconds..."
  Start-Sleep -Seconds $RestartDelaySeconds
}
