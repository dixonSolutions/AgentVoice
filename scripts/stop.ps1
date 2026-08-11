#Requires -Version 5.1
<#
.SYNOPSIS
    AgentVoice — stop script for Windows (production host)

.DESCRIPTION
    Stops the production HOST bridge (the long-running AgentVoice service).
      1. Stops the AgentVoice Windows service (if installed)
      2. Falls back to killing the manual process (data\.bridge.pid)
      3. Frees the host bridge port (PORT, default 8787) as a safety net

    The local dev server (`npm run dev`) runs on a SEPARATE port (test profile,
    default 5089) and is unaffected. Start the host back up with: npm run start:service

.PARAMETER Quiet
    Only print warnings/errors.

.EXAMPLE
    .\scripts\stop.ps1
#>
[CmdletBinding()]
param(
    [switch] $Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

function Info    ($msg) { if (-not $Quiet) { Write-Host "[info]  $msg" -ForegroundColor Cyan } }
function Ok      ($msg) { if (-not $Quiet) { Write-Host "[ok]    $msg" -ForegroundColor Green } }
function Warn    ($msg) { Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Err     ($msg) { Write-Host "[err]   $msg" -ForegroundColor Red; throw $msg }
function Section ($msg) { if (-not $Quiet) { Write-Host "`n── $msg ──" -ForegroundColor Magenta } }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ([Security.Principal.WindowsPrincipal]$id).IsInRole(
        [Security.Principal.WindowsBuiltinRole]::Administrator)
}

$ServiceName = 'AgentVoice'
$EnvFile     = Join-Path $ProjectDir '.env'

# ── Load .env for PORT ──────────────────────────────────────────────────────
$ActualPort = 8787
if (Test-Path $EnvFile) {
    $portLine = Select-String -Path $EnvFile -Pattern '^PORT=(.+)' | Select-Object -First 1
    if ($portLine) { $ActualPort = [int]$portLine.Matches[0].Groups[1].Value.Trim() }
}

if (-not $Quiet) {
    Write-Host "AgentVoice — stop host (Windows)" -ForegroundColor Magenta
    Write-Host "  Project: $ProjectDir"
}

# ── 1. Stop the Windows service ─────────────────────────────────────────────
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($service) {
    if ($service.Status -ne 'Stopped') {
        if (-not (Test-Admin)) {
            Warn "Relaunching with admin rights to stop the service..."
            $psArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path)
            if ($Quiet) { $psArgs += '-Quiet' }
            Start-Process pwsh -ArgumentList $psArgs -Verb RunAs -Wait
            exit
        }
        Section "Stopping service"
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        Start-Sleep 2
        Ok "'$ServiceName' stopped."
    } else {
        Info "'$ServiceName' already stopped."
    }
}

# ── 2. Stop manual process (restart.ps1 fallback path) ──────────────────────
$pidFile = Join-Path $ProjectDir 'data\.bridge.pid'
if (Test-Path $pidFile) {
    $procId = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($procId) {
        $proc = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
        if ($proc) {
            Section "Stopping manual bridge process"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            Ok "Stopped bridge pid $($proc.Id)."
        }
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
}

# ── 3. Free ports as a final safety net ─────────────────────────────────────
function Clear-Port {
    param([int] $Port, [string] $Label)
    $conns = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if (-not $conns) { Info "Port $Port ($Label) already free."; return }
    $pids = $conns.OwningProcess | Sort-Object -Unique
    Warn "Port $Port ($Label) still held by PID(s): $($pids -join ', ') — terminating."
    foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    Start-Sleep 1
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
        Err "Port $Port ($Label) is STILL in use — investigate manually."
    }
    Ok "Port $Port ($Label) freed."
}

Section "Freeing host port"
Clear-Port -Port $ActualPort -Label 'host bridge'

if (-not $Quiet) {
    Write-Host ""
    Ok "AgentVoice host stopped. Start it again with: npm run start:service"
    Write-Host ""
}
