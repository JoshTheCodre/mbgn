# Switches on WhatsApp messages to contestants, in one go:
#   1. saves the sender token (from .secrets\whatsapp-sender-token.txt) on Vercel and deploys the site
#   2. copies the sender to your VPS, installs it there, starts it, and shows the code to link the
#      contest phone
# Safe to run again later, to update the sender: the WhatsApp login on the VPS is kept.
#
# Run it from the project folder, signed in to Vercel (npx vercel login):
#   powershell -ExecutionPolicy Bypass -File scripts\whatsapp-vps.ps1 -Server root@YOUR_VPS_IP
#
# Options:
#   -EvolutionUrl https://...       send through your Evolution API server instead of linking the
#                                   phone here; it asks for Evolution's API key (hidden)
#   -EvolutionInstance mbgn         the instance name in Evolution (default mbgn)
#   -Port 2222                      if your VPS's SSH is not on port 22
#   -PairingNumber 2348012345678    link with an 8-character code instead of scanning a QR code
#   -SkipVercel                     the site already has the token and is deployed
#   -PackageOnly                    only build the upload, into .secrets\, to copy over yourself
#
# Your VPS asks for its password twice (once to copy, once to set up), unless you use an SSH key.

param(
  [string]$Server = '',
  [int]$Port = 22,
  [string]$EvolutionUrl = '',
  [string]$EvolutionInstance = 'mbgn',
  [string]$PairingNumber = '',
  [switch]$SkipVercel,
  [switch]$PackageOnly
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

if (-not $PackageOnly -and $Server -notmatch '^[^@\s]+@[^@\s]+$') {
  throw 'Give your VPS login as -Server user@address, for example -Server root@203.0.113.10'
}
$PairingNumber = $PairingNumber -replace '\D', ''
$EvolutionUrl = $EvolutionUrl.Trim().TrimEnd('/')
$evolutionKey = ''
if ($EvolutionUrl) {
  if ($EvolutionUrl -notmatch '^https?://') { throw 'Give -EvolutionUrl as the full address, for example https://evolution.example.com' }
  # Kept in .secrets\ if you put it there; otherwise asked for, hidden, and not saved on this PC.
  $keyFile = '.secrets\evolution-api-key.txt'
  if (Test-Path $keyFile) {
    $evolutionKey = (Get-Content $keyFile -Raw).Trim()
  } else {
    $secure = Read-Host "Paste Evolution's API key (it stays hidden)" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $evolutionKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }
  if (-not $evolutionKey) { throw "No Evolution API key given." }
  # Checked now, so a wrong address or key shows here rather than as silence on the VPS.
  try {
    $state = Invoke-RestMethod "$EvolutionUrl/instance/connectionState/$([uri]::EscapeDataString($EvolutionInstance))" -Headers @{ apikey = $evolutionKey } -TimeoutSec 20
    $s = if ($state.instance.state) { $state.instance.state } else { $state.state }
    if ($s -eq 'open') { Write-Host "Evolution instance '$EvolutionInstance' is connected to WhatsApp." -ForegroundColor Green }
    else { Write-Host "Evolution instance '$EvolutionInstance' is not connected yet ($s). Link the phone in Evolution's manager; messages wait until then." -ForegroundColor Yellow }
  } catch {
    throw "Couldn't reach instance '$EvolutionInstance' at $EvolutionUrl with that key: $($_.Exception.Message). Check the address, the key, and that the instance exists in Evolution's manager."
  }
}

$tokenFile = '.secrets\whatsapp-sender-token.txt'
if (-not (Test-Path $tokenFile)) { throw "No sender token found at $tokenFile." }
$token = (Get-Content $tokenFile -Raw).Trim()
if ($token.Length -lt 32) { throw "The token in $tokenFile looks too short." }
$siteUrl = 'https://www.mbgn.com.ng'

# ---- 1. The site ----
if (-not $PackageOnly -and -not $SkipVercel) {
  Write-Host ''
  Write-Host 'Saving WHATSAPP_SENDER_TOKEN on Vercel (production)...'
  # Through the keyboard input, so the token stays out of the shell history. Run through cmd,
  # because Windows PowerShell treats Vercel's hidden progress messages as errors.
  cmd /c "npx vercel env rm WHATSAPP_SENDER_TOKEN production --yes >nul 2>&1"
  $token | npx vercel env add WHATSAPP_SENDER_TOKEN production | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Vercel did not accept the token. Check you are signed in (npx vercel login) and try again.' }
  Write-Host '  Saved' -ForegroundColor Green

  Write-Host ''
  Write-Host 'Deploying the site, so it starts writing down WhatsApp messages...'
  npx vercel --prod --yes
  if ($LASTEXITCODE -ne 0) { throw 'The deploy failed. The token is saved; run this again with -SkipVercel after npx vercel --prod --yes works.' }
}

# ---- 2. The upload: the sender's code plus its settings ----
$stage = Join-Path ([IO.Path]::GetTempPath()) "mbgn-whatsapp-$([guid]::NewGuid().ToString('N'))"
$archive = if ($PackageOnly) { Join-Path (Resolve-Path '.secrets') 'mbgn-whatsapp.tgz' } else { "$stage.tgz" }
try {
  New-Item -ItemType Directory -Path $stage | Out-Null
  foreach ($item in 'package.json', 'package-lock.json', 'README.md', '.env.example', 'src') {
    Copy-Item -Recurse (Join-Path 'whatsapp-sender' $item) $stage
  }
  # Linux line endings, and no byte-order mark, or bash cannot run it.
  $setup = (Get-Content 'whatsapp-sender\setup-vps.sh' -Raw) -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $stage 'setup-vps.sh'), $setup)
  $transportLines = if ($EvolutionUrl) {
    @('TRANSPORT=evolution', "EVOLUTION_URL=$EvolutionUrl", "EVOLUTION_API_KEY=$evolutionKey", "EVOLUTION_INSTANCE=$EvolutionInstance")
  } else {
    @('TRANSPORT=baileys', 'AUTH_DIR=auth', "PAIRING_NUMBER=$PairingNumber")
  }
  $envLines = @("SITE_URL=$siteUrl", "WHATSAPP_SENDER_TOKEN=$token") + $transportLines + @('SEND_GAP_SECONDS=6', 'POLL_SECONDS=15')
  [IO.File]::WriteAllText((Join-Path $stage '.env'), ($envLines -join "`n") + "`n")

  tar -czf $archive -C $stage .
  if ($LASTEXITCODE -ne 0) { throw 'Could not pack the sender.' }

  if ($PackageOnly) {
    Write-Host ''
    Write-Host "Built $archive" -ForegroundColor Green
    Write-Host 'It holds the sender token, so keep it private. On the VPS:'
    Write-Host '  mkdir -p ~/mbgn-whatsapp && tar -xzf mbgn-whatsapp.tgz -C ~/mbgn-whatsapp && bash ~/mbgn-whatsapp/setup-vps.sh'
    exit 0
  }

  # ---- 3. The VPS ----
  Write-Host ''
  Write-Host "Copying the sender to $Server..."
  scp -P $Port $archive "${Server}:mbgn-whatsapp.tgz"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy to $Server. Check the address, port and password." }

  Write-Host ''
  Write-Host 'Setting it up on the VPS. The first time takes a few minutes (it installs Node.js and pm2)...'
  $remote = 'mkdir -p ~/mbgn-whatsapp && tar -xzf ~/mbgn-whatsapp.tgz -C ~/mbgn-whatsapp && rm ~/mbgn-whatsapp.tgz && bash ~/mbgn-whatsapp/setup-vps.sh'
  # -t: a real terminal, so the QR code shows properly and Ctrl+C closes the view.
  ssh -t -p $Port $Server $remote
  Write-Host ''
  Write-Host 'Check it in admin: Messages > WhatsApp messages should say the sender is connected.' -ForegroundColor Green
  Write-Host 'Then press "Message accepted contestants who haven''t had one" there, to catch up.'
}
finally {
  # The copy on this PC holds the token, so it goes.
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  if (-not $PackageOnly) { Remove-Item -Force "$stage.tgz" -ErrorAction SilentlyContinue }
}
