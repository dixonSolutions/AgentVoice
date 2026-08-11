#Requires -Version 5.1
<#
.SYNOPSIS
    AgentVoice — start script for Windows (production host)

.DESCRIPTION
    Starts the production HOST bridge back up after stop.ps1.
    Counterpart to scripts\stop.ps1. (The local dev server `npm run dev` runs on a
    separate port — default 5089 — and is managed independently.)
      1. Starts the AgentVoice Windows service (if installed)
      2. Falls back to a manual background process when no service exists
      3. Runs a /healthz check to confirm startup

.PARAMETER Tail
    Stream bridge.log after start (Ctrl-C to stop).

.EXAMPLE
    .\scripts\start.ps1
#>
[CmdletBinding()]
param(
    [switch] $Tail
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

function Info    ($msg) { Write-Host "[info]  $msg" -ForegroundColor Cyan }
function Ok      ($msg) { Write-Host "[ok]    $msg" -ForegroundColor Green }
function Warn    ($msg) { Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Err     ($msg) { Write-Host "[err]   $msg" -ForegroundColor Red; throw $msg }
function Section ($msg) { Write-Host "`n── $msg ──" -ForegroundColor Magenta }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ([Security.Principal.WindowsPrincipal]$id).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

$ServiceName = 'AgentVoice'
$EnvFile     = Join-Path $ProjectDir '.env'
$LogFile     = Join-Path $ProjectDir 'logs\bridge.log'

# ── Load .env for PORT ──────────────────────────────────────────────────────
$ActualPort = 8787
if (Test-Path $EnvFile) {
    $portLine = Select-String -Path $EnvFile -Pattern '^PORT=(.+)' | Select-Object -First 1
    if ($portLine) { $ActualPort = [int]$portLine.Matches[0].Groups[1].Value.Trim() }
}

Write-Host "AgentVoice — start (Windows)" -ForegroundColor Magenta
Write-Host "  Project: $ProjectDir"

# Guard: refuse to start if the host port is already taken.
if (Get-NetTCPConnection -State Listen -LocalPort $ActualPort -ErrorAction SilentlyContinue) {
    Err "Host port $ActualPort is already in use — is the host already running? Stop it with: npm run stop"
}

# ── Start the Windows service, else manual background process ───────────────
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    if (-not (Test-Admin)) {
        Warn "Relaunching with admin rights to start the service..."
        $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path)
        if ($Tail) { $psArgs += '-Tail' }
        Start-Process pwsh -ArgumentList $psArgs -Verb RunAs -Wait
        exit
    }
    Section "Starting service"
    Start-Service -Name $ServiceName
    Start-Sleep 2
    $svc = Get-Service -Name $ServiceName
    if ($svc.Status -eq 'Running') {
        Ok "'$ServiceName' is running."
    } else {
        Warn "'$ServiceName' status: $($svc.Status). Check: Get-Content '$LogFile' -Tail 30"
    }
} else {
    Section "Starting bridge manually (no service)"
    Warn "Service '$ServiceName' not found. Run setup.ps1 to install it."

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $NodeBin = if ($nodeCmd) { $nodeCmd.Source } else { 'node' }
    $distFile = Join-Path $ProjectDir 'dist\index.js'
    if (-not (Test-Path $distFile)) { Err "dist\index.js not found — build first: npm run build" }

    New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
    if (Test-Path $EnvFile) {
        Get-Content $EnvFile | ForEach-Object {
            if ($_ -match '^([^#\s][^=]+)=(.+)$') {
                [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
            }
        }
    }

    $proc = Start-Process -FilePath $NodeBin `
        -ArgumentList $distFile `
        -WorkingDirectory $ProjectDir `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError (Join-Path $ProjectDir 'logs\bridge-error.log') `
        -WindowStyle Hidden `
        -PassThru

    Start-Sleep 2
    if (-not $proc.HasExited) {
        New-Item -ItemType Directory -Force -Path (Join-Path $ProjectDir 'data') | Out-Null
        $proc.Id | Set-Content (Join-Path $ProjectDir 'data\.bridge.pid')
        Ok "Bridge started (pid $($proc.Id)). Log: $LogFile"
    } else {
        Err "Bridge exited immediately. Check: Get-Content '$LogFile' -Tail 30"
    }
}

# ── Health check ────────────────────────────────────────────────────────────
Section "Health check"
Start-Sleep 2
$healthUrl = "http://127.0.0.1:$ActualPort/healthz"
try {
    $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 5
    Ok "Bridge is healthy at $healthUrl"
    $resp | ConvertTo-Json -Depth 3
} catch {
    Warn "Health check failed at $healthUrl — bridge may still be starting."
    Warn "Try: Invoke-RestMethod $healthUrl"
}

if ($Tail) {
    Write-Host ""
    Info "Tailing $LogFile (Ctrl-C to stop)..."
    Get-Content $LogFile -Wait
}

Write-Host ""
Ok "Start complete."
Write-Host ""
