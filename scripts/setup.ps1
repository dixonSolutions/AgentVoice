#Requires -Version 5.1
<#
.SYNOPSIS
    AgentVoice — host setup for Windows

.DESCRIPTION
    What this script does:
      1. Checks prerequisites (Node >= 20, npm, git, cursor-agent)
      2. Installs Tailscale via winget (if missing)
      3. Builds the project (backend + PWA)
      4. Creates .env with a generated APP_TOKEN (if missing)
      5. Installs the bridge as a Windows Service using NSSM
      6. Creates a scheduled task to auto-restart the service when
         dist\index.js changes (built output watcher)
      7. Configures tailscale serve (HTTPS proxy to the bridge)
      8. Prints a next-step checklist

.PARAMETER Port
    Bridge listen port (default: 8787)

.PARAMETER NoTailscale
    Skip Tailscale installation and tailscale serve setup

.EXAMPLE
    # Run from the project root
    .\scripts\setup.ps1

.EXAMPLE
    .\scripts\setup.ps1 -Port 9000 -NoTailscale

.NOTES
    Run as Administrator for service installation and Tailscale setup.
    Requires winget (Windows Package Manager) — available on Win 10 1809+ / Win 11.
#>
[CmdletBinding()]
param(
    [int]    $Port        = 8787,
    [switch] $NoTailscale
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ── Resolve paths ─────────────────────────────────────────────────────────
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

# ── Helpers ───────────────────────────────────────────────────────────────
function Info    ($msg) { Write-Host "[info]  $msg" -ForegroundColor Cyan }
function Ok      ($msg) { Write-Host "[ok]    $msg" -ForegroundColor Green }
function Warn    ($msg) { Write-Host "[warn]  $msg" -ForegroundColor Yellow }
function Err     ($msg) { Write-Host "[err]   $msg" -ForegroundColor Red; throw $msg }
function Section ($msg) { Write-Host "`n── $msg ──" -ForegroundColor Magenta }

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = [Security.Principal.WindowsPrincipal]$id
    $p.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

# ── Elevation check ───────────────────────────────────────────────────────
if (-not (Test-Admin)) {
    Warn "Not running as Administrator. Relaunching elevated..."
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path)
    if ($Port -ne 8787)    { $args += '-Port', $Port }
    if ($NoTailscale)      { $args += '-NoTailscale' }
    Start-Process pwsh -ArgumentList $args -Verb RunAs
    exit
}

Info "Project dir: $ProjectDir"
Info "Port: $Port"

# ── 1. Prerequisites ──────────────────────────────────────────────────────
Section "Checking prerequisites"

# Node.js ≥ 20
try {
    $nodeVer = (node --version 2>&1).TrimStart('v')
    $nodeMaj = [int]($nodeVer.Split('.')[0])
    if ($nodeMaj -lt 20) { Err "Node.js >= 20 required (found v$nodeVer). Get it from https://nodejs.org" }
    Ok "Node.js v$nodeVer"
} catch {
    Err "Node.js not found. Install from https://nodejs.org (v20 LTS recommended)"
}

try   { $npmVer = (npm --version 2>&1); Ok "npm $npmVer" }
catch { Err "npm not found. Install Node.js from https://nodejs.org" }

try   { $gitVer = (git --version 2>&1); Ok $gitVer }
catch { Err "git not found. Install from https://git-scm.com" }

$CursorAgentAvailable = $false
try {
    $caVer = (cursor-agent --version 2>&1)
    Ok "cursor-agent $caVer"
    $CursorAgentAvailable = $true
} catch {
    Warn "cursor-agent not found."
    Warn "Install Cursor IDE, then: Ctrl+Shift+P → 'Install cursor-agent in PATH'"
    Warn "The service will fail to start until cursor-agent is available."
}

$NodeExe  = (Get-Command node).Source
$NpmExe   = (Get-Command npm).Source

# ── 2. Tailscale ──────────────────────────────────────────────────────────
Section "Tailscale"

if ($NoTailscale) {
    Warn "Skipping Tailscale setup (-NoTailscale)."
} else {
    $tsInstalled = $null -ne (Get-Command tailscale -ErrorAction SilentlyContinue)

    if ($tsInstalled) {
        Ok "Tailscale already installed: $(tailscale --version | Select-Object -First 1)"
    } else {
        Info "Installing Tailscale via winget..."
        try {
            winget install --id Tailscale.Tailscale --silent --accept-package-agreements --accept-source-agreements
            Ok "Tailscale installed. Restart may be required for PATH update."
            # Refresh PATH in this session
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                        [System.Environment]::GetEnvironmentVariable('Path','User')
        } catch {
            Warn "winget install failed: $_"
            Warn "Install Tailscale manually from https://tailscale.com/download/windows"
        }
    }

    # Enable MagicDNS so *.ts.net hostnames resolve locally (needed for HTTPS URL).
    try {
        tailscale set --accept-dns=true 2>$null
        Ok "Tailscale MagicDNS enabled (*.ts.net resolves locally)."
    } catch {
        Warn "Could not enable MagicDNS — run: tailscale set --accept-dns=true"
    }
}

# ── 3. Build project ──────────────────────────────────────────────────────
Section "Building project"

Info "Installing npm dependencies..."
npm ci --no-audit --prefer-offline
if ($LASTEXITCODE -ne 0) { npm install --no-audit --legacy-peer-deps }

Info "Building backend + PWA..."
npm run build
if ($LASTEXITCODE -ne 0) { Err "Build failed. Check output above." }

Ok "Build complete → dist\index.js + web\dist\"

# ── 4. Environment file ───────────────────────────────────────────────────
Section "Environment (.env)"

$EnvFile = Join-Path $ProjectDir '.env'

if (-not (Test-Path $EnvFile)) {
    Info "Creating .env with a generated APP_TOKEN..."

    # Generate a cryptographically random 32-byte token
    $rng   = [System.Security.Cryptography.RNGCryptoServiceProvider]::new()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    $AppToken = [Convert]::ToBase64String($bytes) -replace '[+/=]', ''
    $AppToken = $AppToken.Substring(0, [Math]::Min(43, $AppToken.Length))

    $envContent = @"
# AgentVoice — secrets + machine-specific paths
# Keep this file private and never commit it.

APP_TOKEN=$AppToken

PORT=$Port
CONFIG_PATH=$ProjectDir\config.json
DB_PATH=$ProjectDir\data\state.db

# AWS credentials (optional — only needed for Polly/Transcribe/Bedrock)
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_REGION=us-east-1
"@
    Set-Content -Path $EnvFile -Value $envContent -Encoding UTF8

    # Restrict permissions to current user only
    $acl = Get-Acl $EnvFile
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $env:USERNAME, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -Path $EnvFile -AclObject $acl

    Ok ".env created."
    Warn "APP_TOKEN: $AppToken"
    Warn "Copy this token into the PWA settings screen."
} else {
    Ok ".env already exists — preserving existing values."
    if (-not (Select-String -Path $EnvFile -Pattern '^PORT=' -Quiet)) {
        Add-Content -Path $EnvFile -Value "PORT=$Port"
        Info "Added PORT=$Port to existing .env."
    }
}

# Read actual port from .env
$ActualPort = (Select-String -Path $EnvFile -Pattern '^PORT=(.+)').Matches[0].Groups[1].Value.Trim()

# ── 5. Config skeleton ────────────────────────────────────────────────────
Section "Config (config.json)"

$ConfigFile = Join-Path $ProjectDir 'config.json'
if (-not (Test-Path $ConfigFile)) {
    $exampleConfig = Join-Path $ProjectDir 'config.example.json'
    if (Test-Path $exampleConfig) {
        Copy-Item $exampleConfig $ConfigFile
        Ok "config.json created from config.example.json"
    } else {
        $configContent = @'
{
  "settings": {
    "runMode": "serve",
    "runModes": {
      "serve": {
        "backendPort": 8787,
        "publicBaseUrl": "https://REPLACE-WITH-YOUR-TAILSCALE-HOSTNAME"
      }
    },
    "maxConcurrentJobs": 3,
    "jobTimeoutMs": 600000,
    "preRunFlags": ["--force", "--trust"],
    "narratorEnabled": true,
    "narratorCadenceMs": 15000,
    "logLevel": "info"
  },
  "projects": []
}
'@
        Set-Content -Path $ConfigFile -Value $configContent -Encoding UTF8
        Ok "config.json skeleton created — add your projects[] and set publicBaseUrl."
    }
} else {
    Ok "config.json already exists."
}

New-Item -ItemType Directory -Force -Path (Join-Path $ProjectDir 'data') | Out-Null

# ── 6. Windows Service (NSSM) ─────────────────────────────────────────────
Section "Windows Service"

$ServiceName = 'AgentVoice'
$NssmPath    = Join-Path $ProjectDir 'tools\nssm.exe'

# Download NSSM if not present
if (-not (Test-Path $NssmPath)) {
    Info "Downloading NSSM (Non-Sucking Service Manager)..."
    $NssmDir = Join-Path $ProjectDir 'tools'
    New-Item -ItemType Directory -Force -Path $NssmDir | Out-Null

    $NssmZip  = Join-Path $env:TEMP 'nssm.zip'
    $NssmUrl  = 'https://nssm.cc/release/nssm-2.24.zip'
    try {
        Invoke-WebRequest -Uri $NssmUrl -OutFile $NssmZip -UseBasicParsing
        Expand-Archive -Path $NssmZip -DestinationPath $env:TEMP -Force
        $NssmBin = Get-ChildItem -Path $env:TEMP -Filter 'nssm.exe' -Recurse |
                   Where-Object { $_.FullName -like '*win64*' } |
                   Select-Object -First 1
        Copy-Item $NssmBin.FullName $NssmPath
        Remove-Item $NssmZip -Force
        Ok "NSSM downloaded → $NssmPath"
    } catch {
        Warn "Could not download NSSM automatically: $_"
        Warn "Download nssm.exe from https://nssm.cc and place it at: $NssmPath"
        Warn "Then re-run this script."
        exit 1
    }
}

# Remove existing service if present (safe re-run)
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService) {
    Info "Stopping and removing existing '$ServiceName' service..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    & $NssmPath remove $ServiceName confirm 2>&1 | Out-Null
    Start-Sleep 2
}

# Install service
Info "Installing '$ServiceName' as a Windows service..."
& $NssmPath install $ServiceName $NodeExe "$ProjectDir\dist\index.js"
& $NssmPath set $ServiceName AppDirectory $ProjectDir
& $NssmPath set $ServiceName Description 'AgentVoice Bridge — voice-controlled coding assistant'
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath set $ServiceName AppRestartDelay 3000

# Log files
$LogDir = Join-Path $ProjectDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
& $NssmPath set $ServiceName AppStdout "$LogDir\bridge.log"
& $NssmPath set $ServiceName AppStderr "$LogDir\bridge-error.log"
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateBytes 10485760  # 10 MB

# Inject .env variables into the service environment
Info "Loading .env into service environment..."
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^([^#\s][^=]+)=(.+)$') {
        $k = $matches[1].Trim()
        $v = $matches[2].Trim()
        & $NssmPath set $ServiceName AppEnvironmentExtra "+$k=$v" 2>&1 | Out-Null
    }
}
& $NssmPath set $ServiceName AppEnvironmentExtra "+NODE_ENV=production" 2>&1 | Out-Null

# Start the service
Start-Service -Name $ServiceName
Ok "'$ServiceName' service installed and running."
Get-Service -Name $ServiceName | Select-Object Name, Status, StartType

# ── 7. File watcher scheduled task (auto-restart on new builds) ───────────
Section "Build watcher (auto-restart)"

$WatcherTaskName   = 'AgentVoice-BuildWatcher'
$WatcherScriptPath = Join-Path $ProjectDir 'scripts\_watcher.ps1'

# Write the watcher helper script
$watcherContent = @"
# Auto-generated by setup.ps1 — watches dist\index.js and restarts the service
# on any change (triggered by npm run build or restart.ps1).
param([string]\$ProjectDir = '$ProjectDir')

\$distFile = Join-Path \$ProjectDir 'dist\index.js'
\$serviceName = 'AgentVoice'
\$watcher = [System.IO.FileSystemWatcher]::new((Split-Path \$distFile), (Split-Path \$distFile -Leaf))
\$watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite
\$watcher.EnableRaisingEvents = \$true

Write-Host "[watcher] Watching: \$distFile"
while (`$true) {
    \$event = Wait-Event -SourceIdentifier 'DistChanged' -Timeout 5
    if (\$null -ne \$event) {
        Remove-Event -SourceIdentifier 'DistChanged'
        Write-Host "[watcher] dist\index.js changed — restarting service..."
        Start-Sleep 1  # brief settle time
        Restart-Service -Name \$serviceName -Force -ErrorAction SilentlyContinue
        Write-Host "[watcher] Service restarted."
    }
    Register-ObjectEvent -InputObject \$watcher -EventName Changed ``
        -SourceIdentifier 'DistChanged' -Action {} | Out-Null
}
"@
Set-Content -Path $WatcherScriptPath -Value $watcherContent -Encoding UTF8

# Remove existing task (safe re-run)
Unregister-ScheduledTask -TaskName $WatcherTaskName -Confirm:$false -ErrorAction SilentlyContinue

# Create a scheduled task that runs the watcher on logon as a background process
$action  = New-ScheduledTaskAction `
    -Execute 'pwsh.exe' `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$WatcherScriptPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval ([TimeSpan]::FromMinutes(1))
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Highest

Register-ScheduledTask `
    -TaskName $WatcherTaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Monitors dist\index.js and restarts AgentVoice service on new builds' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $WatcherTaskName
Ok "Build watcher task registered and started ('$WatcherTaskName')."

# ── 8. Tailscale serve ────────────────────────────────────────────────────
Section "Tailscale HTTPS proxy"

if ($NoTailscale) {
    Warn "Skipping tailscale serve (-NoTailscale)."
} elseif (-not (Get-Command tailscale -ErrorAction SilentlyContinue)) {
    Warn "tailscale not found — skipping serve setup."
} else {
    try {
        # Running as Administrator so operator set is not needed on Windows.
        # Use full URL syntax required by newer tailscale CLI.
        $serveTarget = "http://127.0.0.1:$ActualPort"
        Info "Configuring: tailscale serve --bg $serveTarget"
        tailscale serve --bg $serveTarget
        Ok "tailscale serve configured."

        # Try to detect hostname
        $tsStatus = tailscale status --json 2>$null | ConvertFrom-Json -ErrorAction SilentlyContinue
        $tsHost   = $tsStatus.Self.DNSName.TrimEnd('.')
        if ($tsHost) {
            $PublicUrl = "https://$tsHost"
            Ok "Bridge is at: $PublicUrl"
            # Update config.json placeholder
            $cfgRaw = Get-Content $ConfigFile -Raw
            if ($cfgRaw -like '*REPLACE-WITH-YOUR-TAILSCALE-HOSTNAME*') {
                $cfgRaw = $cfgRaw -replace 'https://REPLACE-WITH-YOUR-TAILSCALE-HOSTNAME', $PublicUrl
                Set-Content -Path $ConfigFile -Value $cfgRaw -Encoding UTF8
                Ok "Updated publicBaseUrl in config.json → $PublicUrl"
            }
        }
    } catch {
        Warn "tailscale serve failed: $_"
        Warn "Run manually: tailscale serve --bg http://127.0.0.1:$ActualPort"
    }
}

# ── 9. Next steps ─────────────────────────────────────────────────────────
Section "Setup complete"

Write-Host ""
Write-Host "Checklist:" -ForegroundColor Bold
Write-Host ""
Write-Host "  [OK]  Bridge built and running as '$ServiceName' Windows service" -ForegroundColor Green
Write-Host "  [OK]  Auto-restarts on crash (NSSM restart policy)" -ForegroundColor Green
Write-Host "  [OK]  Auto-restarts on new build (build watcher scheduled task)" -ForegroundColor Green
Write-Host ""
Write-Host "  [>>]  Action required:" -ForegroundColor Yellow
Write-Host ""
if (-not $NoTailscale) {
    Write-Host "     1. Enable HTTPS certs in Tailscale admin console:"
    Write-Host "        https://login.tailscale.com/admin/dns -> HTTPS Certificates -> Enable"
    Write-Host ""
}
Write-Host "     2. Add your projects to config.json:"
Write-Host "        notepad `"$ConfigFile`""
Write-Host ""
Write-Host "     3. Open the PWA and enter your APP_TOKEN:"
$token = (Select-String -Path $EnvFile -Pattern '^APP_TOKEN=(.+)').Matches[0].Groups[1].Value.Trim()
Write-Host "        APP_TOKEN: $token" -ForegroundColor Yellow
Write-Host ""
Write-Host "     4. After editing config.json, restart the service:"
Write-Host "        .\scripts\restart.ps1"
Write-Host ""
Write-Host "  Logs:"
Write-Host "        Get-Content '$LogDir\bridge.log' -Wait"
Write-Host ""
