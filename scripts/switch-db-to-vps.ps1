# Moves the live site onto the database Coolify runs on your VPS, starting empty (the site hasn't
# launched, so nothing is carried over). Everything runs from this PC:
#   1. empties the VPS database and builds the site's tables in it
#   2. points the site on Vercel at it, moves the site's server code to Washington DC (next to the
#      VPS), and deploys
# The admin login stays the same: it comes from ADMIN_EMAIL and ADMIN_PASSWORD on Vercel.
#
# From the project folder, signed in to Vercel (npx vercel login):
#   powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1
#
# Once switched, running it again does nothing, so live data can't be wiped by accident.
# -Force empties it anyway.
#
# After changing the database's password in Coolify, give the site the new address (nothing is
# emptied):
#   powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1 -NewAddress

param([switch]$Force, [switch]$NewAddress)

$ErrorActionPreference = 'Stop'
# Any stop shows as one plain message, not PowerShell's error details.
trap {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
Set-Location (Split-Path $PSScriptRoot -Parent)
$site = 'https://www.mbgn.com.ng'
$vpsFile = '.secrets\vps-database-url.txt'
$switchedFile = '.secrets\switched-to-vps.txt'
New-Item -ItemType Directory -Force '.secrets' | Out-Null

function Save-Secret([string]$File, [string]$Value) {
  [IO.File]::WriteAllText((Join-Path (Resolve-Path '.secrets') (Split-Path $File -Leaf)), $Value + "`n")
}

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Confirm-Step([string]$Question) {
  (Read-Host "$Question [y/N]") -match '^[Yy]'
}

function Set-VercelEnv([string]$Name, [string]$Value) {
  # Through the keyboard input, so the value stays out of the shell history. Run through cmd,
  # because Windows PowerShell treats Vercel's progress messages as errors.
  cmd /c "npx vercel env rm $Name production --yes >nul 2>&1"
  if ($Value) {
    $Value | npx vercel env add $Name production | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Vercel did not accept $Name. Sign in with: npx vercel login. Then run this again." }
  }
}

function Set-Region([string]$Region) {
  $json = Get-Content 'vercel.json' -Raw
  $updated = $json -replace '"regions"\s*:\s*\[[^\]]*\]', "`"regions`": [`"$Region`"]"
  if ($updated -notmatch [regex]::Escape("`"$Region`"")) { throw 'Could not set the region in vercel.json.' }
  [IO.File]::WriteAllText((Resolve-Path 'vercel.json'), $updated)
}

# Runs a helper script with the address passed privately, and returns its JSON result.
# A brief internet hiccup is tried again.
function Invoke-Helper([string]$Script, [hashtable]$Env) {
  foreach ($attempt in 1..3) {
    foreach ($k in $Env.Keys) { Set-Item "Env:$k" $Env[$k] }
    $result = $null
    try {
      node $Script | ForEach-Object {
        if ($_ -like '{*') { $result = $_ } else { Write-Host "  $_" }
      }
    } finally {
      foreach ($k in $Env.Keys) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
    }
    $parsed = if (-not $result) { [pscustomobject]@{ error = 'It stopped without saying why (see above).' } }
      else { try { $result | ConvertFrom-Json } catch { [pscustomobject]@{ error = $result } } }
    if (-not ($parsed.error -match 'ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|Connection terminated|timeout') -or $attempt -eq 3) { return $parsed }
    Write-Host '  Internet hiccup. Trying again...' -ForegroundColor Yellow
    Start-Sleep -Seconds 5
  }
}

# Asks for Coolify's public address and turns it into the one the site uses.
function Read-VpsAddress {
  Write-Host ''
  Write-Host 'Paste your VPS database address.'
  Write-Host '  Where: Coolify > your database > Postgres URL (public)'
  Write-Host '  Right-click to paste. Nothing shows. Press Enter.'
  $raw = Read-Secret 'VPS address'
  $address = ([regex]::Match($raw, 'postgres(ql)?://[^''"\s]+')).Value
  if (-not $address) { throw "That's not a database address. It should start with postgres://" }
  $hostName = ([regex]::Match($address, '^postgres(?:ql)?://.*@([^:/?#@]+)')).Groups[1].Value
  if ($hostName -notmatch '\.') {
    throw "Wrong address: that one only works inside the VPS.`nIn Coolify, copy 'Postgres URL (public)' instead. It contains 162.35.44.225."
  }
  # The site's data is in its own database, "mbgn", not Coolify's default one.
  $address = $address -replace '^(postgres(?:ql)?://[^/?#]+)(/[^?#]*)?', '$1/mbgn'
  # Encrypted, without needing Coolify's certificate file: sslmode=no-verify.
  $parts = $address -split '\?', 2
  $query = @(if ($parts.Count -gt 1) { $parts[1] -split '&' | Where-Object { $_ -and $_ -notmatch '^(ssl|uselibpqcompat=)' } })
  $parts[0] + '?' + (@($query) + 'sslmode=no-verify' -join '&')
}

# Deploys, then checks the live site answers.
function Publish-Site {
  Write-Host ''
  Write-Host 'Deploying the site (a minute or two)...'
  # Straight to the screen, so it shows and isn't mistaken for this function's answer.
  npx vercel --prod --yes | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'The deploy failed. Run this command to try again:  npx vercel --prod --yes' }
  Write-Host ''
  Write-Host 'Checking the live site...'
  foreach ($i in 1..8) {
    try {
      $res = Invoke-WebRequest "$site/api/competition?check=$(Get-Random)" -UseBasicParsing -TimeoutSec 20
      if ($res.StatusCode -eq 200) { return $true }
    } catch { Start-Sleep -Seconds 5 }
  }
  $false
}

# ---- A new address (after a password change): nothing is emptied ----
if ($NewAddress) {
  $url = Read-VpsAddress
  Write-Host ''
  Write-Host 'Checking the new address...'
  $check = Invoke-Helper 'scripts\reset-db.mjs' @{ MBGN_TO_URL = $url; MBGN_CHECK = '1' }
  if ($check.error) { throw "Couldn't connect with it: $($check.error)`nCheck the address, and that the database was restarted after the change." }
  if (-not $check.encrypted) { throw 'Not encrypted. Turn on SSL for the database in Coolify.' }
  if ($check.tables -lt 1) { throw "That database is empty. It's not the one the site uses." }
  Save-Secret $vpsFile $url
  Write-Host 'Works.' -ForegroundColor Green
  Write-Host 'Saving it on Vercel...'
  Set-VercelEnv 'DATABASE_URL' $url
  if (Publish-Site) {
    Write-Host ''
    Write-Host 'Done! Your live site uses the new address. Nothing was deleted.' -ForegroundColor Green
  } else {
    Write-Host "The site isn't answering yet. Open $site in a minute; if it still fails, tell your developer." -ForegroundColor Red
  }
  exit 0
}

if ((Test-Path $switchedFile) -and -not $Force) {
  Write-Host 'Your live site already uses the VPS database. Nothing to do.' -ForegroundColor Green
  Write-Host 'Changed the database password? Run this with -NewAddress.'
  exit 0
}

# ---- The VPS database address: asked once, then kept in .secrets\ (never leaves this PC) ----
$saveVps = $false
if (Test-Path $vpsFile) {
  $url = (Get-Content $vpsFile -Raw).Trim()
  Write-Host 'Using your saved VPS database address.'
} else {
  $url = Read-VpsAddress
  $saveVps = $true
}

Write-Host ''
Write-Host 'Your live site will start on an EMPTY database on the VPS.' -ForegroundColor Yellow
Write-Host '  Contestants, votes, payments and contest settings start from zero.'
Write-Host '  Your admin login stays the same.'
if (-not (Confirm-Step 'Go ahead?')) { exit 1 }

# ---- 1. Get the VPS database ready ----
Write-Host ''
Write-Host 'Getting the VPS database ready...'
$ready = Invoke-Helper 'scripts\reset-db.mjs' @{ MBGN_TO_URL = $url; MBGN_CONFIRM = 'yes' }
if ($ready.error) {
  Write-Host "Failed: $($ready.error)" -ForegroundColor Red
  Write-Host 'Check in Coolify: SSL on, public access on, database restarted.'
  if (-not $saveVps) {
    # The saved address may be out of date (a new password), so it's asked for again next time.
    Remove-Item $vpsFile -ErrorAction SilentlyContinue
    Write-Host 'Next time, paste the VPS address again.'
  }
  exit 1
}
if (-not $ready.encrypted) { throw 'Not encrypted. Turn on SSL for the database in Coolify.' }
if ($saveVps) { Save-Secret $vpsFile $url }
Write-Host "Ready: $($ready.tables) tables, empty, encrypted." -ForegroundColor Green

# ---- 2. Switch the live site ----
Write-Host ''
Write-Host 'Saving the new address on Vercel...'
Set-VercelEnv 'DATABASE_URL' $url
Save-Secret $switchedFile (Get-Date -Format 'yyyy-MM-dd HH:mm')
# An earlier certificate setting would make the site insist on it, so it goes.
Set-VercelEnv 'DATABASE_CA_CERT' ''
Set-Region 'iad1'
$up = Publish-Site
Write-Host ''
if ($up) {
  Write-Host 'Done! Your live site now uses the VPS database.' -ForegroundColor Green
  Write-Host '  Log in to admin with your usual login, and set up the contest (prices, dates, WhatsApp groups).'
} else {
  Write-Host "The site isn't answering yet. Open $site in a minute; if it still fails, tell your developer." -ForegroundColor Red
}
