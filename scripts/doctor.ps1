#Requires -Version 5.1
<#
.SYNOPSIS
    AgentVoice — connectivity doctor (Windows)

.DESCRIPTION
    Diagnoses why https://<machine>.ts.net might not be reachable.
    Run after setup.ps1 or when the PWA cannot connect to the bridge.

.EXAMPLE
    .\scripts\doctor.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'SilentlyContinue'

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

$Failures = 0

function Pass ($msg) { Write-Host "  [PASS]  $msg" -ForegroundColor Green }
function Fail ($msg) { Write-Host "  [FAIL]  $msg" -ForegroundColor Red;   $script:Failures++ }
function Warn ($msg) { Write-Host "  [WARN]  $msg" -ForegroundColor Yellow }
function Info ($msg) { Write-Host "    -->   $msg" -ForegroundColor Cyan }
function Section ($msg) { Write-Host "`n  -- $msg --" -ForegroundColor Magenta }

Write-Host ""
Write-Host "  AgentVoice -- connectivity doctor (Windows)" -ForegroundColor White
Write-Host ""

# ── Read .env for PORT ────────────────────────────────────────────────────────
$EnvFile    = Join-Path $ProjectDir '.env'
$ActualPort = 8787
if (Test-Path $EnvFile) {
    $portLine = Select-String -Path $EnvFile -Pattern '^PORT=(.+)' | Select-Object -First 1
    if ($portLine) {
        $ActualPort = [int]$portLine.Matches[0].Groups[1].Value.Trim()
    }
}

# ── 1. Windows Service ────────────────────────────────────────────────────────
Section "Windows Service"

$ServiceName = 'AgentVoice'
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    Pass "Windows service '$ServiceName' is running"
} elseif ($svc) {
    Fail "Windows service '$ServiceName' exists but status is: $($svc.Status)"
    Info "Fix: .\scripts\restart.ps1"
} else {
    Fail "Windows service '$ServiceName' not found"
    Info "Fix: run .\scripts\setup.ps1 (as Administrator)"
}

# ── 2. Local bridge ───────────────────────────────────────────────────────────
Section "Local bridge"

$HealthUrl = "http://127.0.0.1:$ActualPort/healthz"
try {
    $resp = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 5 -ErrorAction Stop
    Pass "Bridge responds on $HealthUrl"
} catch {
    Fail "Bridge not responding on $HealthUrl"
    Info "Fix: check service logs — Get-Content '$ProjectDir\logs\bridge-error.log' -Tail 30"
}

# ── 3. Tailscale CLI ──────────────────────────────────────────────────────────
Section "Tailscale CLI"

$TailscaleCmd = Get-Command tailscale -ErrorAction SilentlyContinue
if ($TailscaleCmd) {
    $tsVer = (tailscale --version 2>$null | Select-Object -First 1)
    Pass "Tailscale CLI installed: $tsVer"
} else {
    Fail "Tailscale CLI not found on PATH"
    Info "Fix: install from https://tailscale.com/download/windows or run .\scripts\setup.ps1"
}

# ── 4. Tailscale connection ───────────────────────────────────────────────────
Section "Tailscale connection"

$TsStatusRaw = $null
try {
    $TsStatusRaw = tailscale status --json 2>$null | ConvertFrom-Json -ErrorAction Stop
} catch {}

if ($TsStatusRaw -and $TsStatusRaw.Self) {
    $TsIp   = tailscale ip -4 2>$null
    $TsHost = $TsStatusRaw.Self.DNSName.TrimEnd('.')
    Pass "Tailscale connected (IP: $TsIp, host: $TsHost)"
} else {
    Fail "Tailscale is not connected"
    Info "Fix: open Tailscale system tray app and log in, or run: tailscale up"
    $TsHost = $null
}

# ── 5. MagicDNS (hostname resolution) ────────────────────────────────────────
Section "MagicDNS / hostname resolution"

if ($TsStatusRaw) {
    $CorpDns = $false
    try {
        $prefsRaw = tailscale debug prefs 2>$null
        $CorpDns  = ($prefsRaw -match '"CorpDNS": true')
    } catch {}

    if ($CorpDns) {
        Pass "MagicDNS is enabled (CorpDNS=true)"
    } else {
        Fail "MagicDNS is OFF -- *.ts.net hostnames will not resolve"
        Info "Fix: https://login.tailscale.com/admin/dns --> enable MagicDNS"
    }

    if ($TsHost) {
        try {
            $resolved = [System.Net.Dns]::GetHostEntry($TsHost)
            Pass "Hostname resolves: $TsHost --> $($resolved.AddressList[0])"
        } catch {
            Fail "Hostname does NOT resolve: $TsHost"
            Info "Enable MagicDNS and make sure the Tailscale app is connected on this device"
        }
    }
} else {
    Warn "Skipping MagicDNS check (Tailscale not connected)"
}

# ── 6. HTTPS certificates ─────────────────────────────────────────────────────
Section "HTTPS certificates"

try {
    $certOut = tailscale cert 2>&1
    if ($certOut -match 'not enabled') {
        Fail "HTTPS certificates not enabled on tailnet"
        Info "Fix: https://login.tailscale.com/admin/dns --> HTTPS Certificates --> Enable"
    } else {
        Pass "HTTPS certificate support appears enabled"
    }
} catch {
    Warn "Could not run 'tailscale cert' -- Tailscale may not be connected"
}

# ── 7. Tailscale Serve ────────────────────────────────────────────────────────
Section "Tailscale Serve"

try {
    $ServeStatus = tailscale serve status 2>&1
    if ($ServeStatus -match 'no serve config') {
        Fail "Tailscale Serve is not configured"
        Info "Fix: tailscale serve --bg http://127.0.0.1:$ActualPort"
    } elseif ($ServeStatus -match 'not enabled on your tailnet') {
        Fail "Tailscale Serve is not enabled on your tailnet"
        Info "Fix: visit the link printed by: tailscale serve --bg http://127.0.0.1:$ActualPort"
    } else {
        Pass "Tailscale Serve is configured"
        $ServeStatus | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    }
} catch {
    Warn "Could not run 'tailscale serve status'"
}

# ── 8. End-to-end HTTPS test ──────────────────────────────────────────────────
Section "End-to-end HTTPS"

if ($TsHost) {
    $HttpsUrl = "https://$TsHost/healthz"
    try {
        Invoke-RestMethod -Uri $HttpsUrl -TimeoutSec 8 -ErrorAction Stop | Out-Null
        Pass "HTTPS reachable: $HttpsUrl"
    } catch {
        Fail "HTTPS NOT reachable: $HttpsUrl"
        Info "Complete the Serve + MagicDNS + HTTPS cert steps above, then retry"
    }
} else {
    Warn "Skipping HTTPS test (no Tailscale hostname detected)"
}

# ── 9. config.json runMode ────────────────────────────────────────────────────
Section "config.json"

$ConfigFile = Join-Path $ProjectDir 'config.json'
if (Test-Path $ConfigFile) {
    $cfgRaw = Get-Content $ConfigFile -Raw
    if ($cfgRaw -match '"runMode":\s*"serve"') {
        Pass "config.json runMode is 'serve'"
    } else {
        Warn "config.json runMode is not 'serve' -- PWA may point at dev proxy"
        Info "Set settings.runMode to ""serve"" in config.json"
    }
    if ($cfgRaw -match 'REPLACE-WITH-YOUR-TAILSCALE-HOSTNAME') {
        Fail "config.json still has placeholder publicBaseUrl"
        Info "Fix: run .\scripts\setup.ps1 to auto-detect, or edit config.json manually"
    } else {
        Pass "config.json publicBaseUrl has been set"
    }
} else {
    Fail "config.json not found"
    Info "Fix: run .\scripts\setup.ps1"
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
if ($Failures -eq 0) {
    Write-Host "  All checks passed." -ForegroundColor Green
    if ($TsHost) {
        Write-Host "  Open https://$TsHost from a Tailscale-connected device." -ForegroundColor Green
    }
} else {
    Write-Host "  $Failures check(s) failed. Fix the items above, then re-run:" -ForegroundColor Red
    Write-Host "    .\scripts\doctor.ps1" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Quick fix order:" -ForegroundColor White
    Write-Host "    1. Enable MagicDNS:     https://login.tailscale.com/admin/dns"
    Write-Host "    2. Enable HTTPS certs:  same page --> HTTPS Certificates"
    Write-Host "    3. Enable Serve:        run 'tailscale serve --bg $ActualPort' and follow the link"
    Write-Host "    4. Phone must have Tailscale app ON and connected to your tailnet"
}
Write-Host ""
