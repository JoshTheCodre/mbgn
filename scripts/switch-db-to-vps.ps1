# Moves the live site's database from Neon to the one Coolify runs on your VPS. Everything runs
# from this PC; nothing is needed on the VPS but the database itself.
#   1. copies everything from Neon into the VPS database (Neon is only read)
#   2. points the site on Vercel at the VPS database, moves the site's server code to Washington DC
#      (next to the VPS), and deploys
#   3. checks nothing new reached Neon during the switch
#
# Try it first with -Test: it does step 1 only. The live site isn't touched, and you can run it
# as often as you like.
#
# From the project folder, signed in to Vercel (npx vercel login):
#   powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1 -Test
#   powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1
# For the real switch, pause voting in admin first, and resume it after.
#
# To go back to Neon:
#   powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1 -Back
#
# Options:  -Force   copy even if the VPS database has newer data than Neon (from testing)

param(
  [switch]$Test,
  [switch]$Back,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$site = 'https://www.mbgn.com.ng'
$neonFile = '.secrets\neon-database-url.txt'
$vpsFile = '.secrets\vps-database-url.txt'
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
    if ($LASTEXITCODE -ne 0) { throw "Vercel did not accept $Name. Check you are signed in (npx vercel login) and try again." }
  }
}

function Set-Region([string]$Region) {
  $json = Get-Content 'vercel.json' -Raw
  $updated = $json -replace '"regions"\s*:\s*\[[^\]]*\]', "`"regions`": [`"$Region`"]"
  if ($updated -notmatch [regex]::Escape("`"$Region`"")) { throw 'Could not set the region in vercel.json.' }
  [IO.File]::WriteAllText((Resolve-Path 'vercel.json'), $updated)
}

function Publish-Site {
  Write-Host ''
  Write-Host 'Deploying the site...'
  npx vercel --prod --yes
  if ($LASTEXITCODE -ne 0) {
    throw 'The deploy failed, so the live site still runs as before. Fix the error above and run this again.'
  }
  Write-Host ''
  Write-Host 'Checking the live site...'
  foreach ($i in 1..6) {
    try {
      $res = Invoke-WebRequest "$site/api/competition?check=$(Get-Random)" -UseBasicParsing -TimeoutSec 20
      if ($res.StatusCode -eq 200) { Write-Host '  The site is up and reading its database.' -ForegroundColor Green; return }
    } catch { Start-Sleep -Seconds 5 }
  }
  Write-Host "  The site isn't answering properly. Check $site now; to undo, run this again with -Back." -ForegroundColor Red
}

# Runs one of the helper scripts with addresses passed privately, and returns its JSON result.
function Invoke-Helper([string]$Script, [hashtable]$Env) {
  foreach ($k in $Env.Keys) { Set-Item "Env:$k" $Env[$k] }
  $result = $null
  try {
    node $Script | ForEach-Object {
      if ($_ -like '{*') { $result = $_ } else { Write-Host "  $_" }
    }
  } finally {
    foreach ($k in $Env.Keys) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  }
  if (-not $result) { return [pscustomobject]@{ error = 'It stopped without saying why (see above).' } }
  try { $result | ConvertFrom-Json } catch { [pscustomobject]@{ error = $result } }
}

# ---- Going back to Neon ----
if ($Back) {
  if (-not (Test-Path $neonFile)) { throw "Neon's address wasn't kept ($neonFile is missing). Put it back on Vercel by hand: DATABASE_URL." }
  $neon = (Get-Content $neonFile -Raw).Trim()
  Write-Host 'This points the live site back at Neon.'
  Write-Host 'Anything that came in since the switch (votes, payments, sign-ups) stays only on the VPS.' -ForegroundColor Yellow
  if (-not (Confirm-Step 'Go back to Neon?')) { exit 1 }
  Set-VercelEnv 'DATABASE_URL' $neon
  Set-VercelEnv 'DATABASE_CA_CERT' ''
  Set-Region 'fra1'
  Publish-Site
  Write-Host ''
  Write-Host 'The site is back on Neon, in Frankfurt. Commit vercel.json so the next deploy keeps it.'
  exit 0
}

# ---- The two addresses ----
# The VPS database: asked once, then kept in .secrets\ (which never leaves this PC).
if (Test-Path $vpsFile) {
  $url = (Get-Content $vpsFile -Raw).Trim()
  Write-Host "Using the VPS database address kept in $vpsFile (delete that file to give a new one)."
} else {
  $raw = Read-Secret "Paste Coolify's 'Postgres URL (public)' for the database (it stays hidden)"
  $url = ([regex]::Match($raw, 'postgres(ql)?://[^''"\s]+')).Value
  if (-not $url) { throw "That doesn't look like a database address. It starts with postgres://" }
  $hostName = ([regex]::Match($url, '^postgres(?:ql)?://[^@/]+@([^:/?#]+)')).Groups[1].Value
  if ($hostName -notmatch '\.') {
    throw "That's the internal address, which only works inside the VPS. In Coolify, turn on 'Make it publicly available' and copy the public one."
  }
  # MBGN's data goes in its own database, "mbgn" (made if needed), not Coolify's default "postgres".
  $url = $url -replace '^(postgres(?:ql)?://[^/?#]+)(/[^?#]*)?', '$1/mbgn'
  # Encrypted: Coolify's own SSL settings in the address are replaced by sslmode=no-verify, which
  # encrypts without needing Coolify's certificate file.
  $parts = $url -split '\?', 2
  $query = @(if ($parts.Count -gt 1) { $parts[1] -split '&' | Where-Object { $_ -and $_ -notmatch '^(ssl|uselibpqcompat=)' } })
  $url = $parts[0] + '?' + (@($query) + 'sslmode=no-verify' -join '&')
  Save-Secret $vpsFile $url
}

# Neon: kept in .secrets\ too, for copying and for -Back.
if (Test-Path $neonFile) {
  $neon = (Get-Content $neonFile -Raw).Trim()
} else {
  $neon = ''
  $pulled = Join-Path ([IO.Path]::GetTempPath()) "mbgn-env-$([guid]::NewGuid().ToString('N')).txt"
  try {
    cmd /c "npx vercel env pull `"$pulled`" --environment=production --yes >nul 2>&1"
    $line = if (Test-Path $pulled) { Get-Content $pulled | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1 } else { $null }
    if ($line) { $neon = ($line -replace '^DATABASE_URL=', '').Trim().Trim('"') }
  } finally {
    # The pulled file holds every production secret, so it goes straight away.
    Remove-Item -Force $pulled -ErrorAction SilentlyContinue
  }
  if ($neon -notmatch 'neon\.tech') {
    $neon = Read-Secret "Paste Neon's connection string (Vercel > Settings > Environment Variables > DATABASE_URL; it stays hidden)"
    if ($neon -notmatch '^postgres') { throw "That doesn't look like a database address. It starts with postgres://" }
  }
  Save-Secret $neonFile $neon
}

# ---- Voting should be paused for the real switch ----
$neonNow = Invoke-Helper 'scripts\check-db.mjs' @{ MBGN_CHECK_URL = $neon }
if ($neonNow.error) { throw "Couldn't read Neon: $($neonNow.error)" }
if ($neonNow.votingOpen -and -not $Test) {
  Write-Host ''
  Write-Host 'Voting is open. Votes paid during the switch would be left behind on Neon.' -ForegroundColor Yellow
  Write-Host 'Pause voting in admin now, then come back here.'
  if (-not (Confirm-Step 'Voting is paused (or you accept the risk)?')) { exit 1 }
}

# ---- 1. Copy ----
Write-Host ''
Write-Host 'Copying Neon into the VPS database. Neon is only read.'
$copy = Invoke-Helper 'scripts\copy-db.mjs' @{ MBGN_FROM_URL = $neon; MBGN_TO_URL = $url; MBGN_FORCE = $(if ($Force) { '1' } else { '' }) }
if ($copy.error) {
  Write-Host "  Not copied: $($copy.error)" -ForegroundColor Red
  Write-Host '  If it could not connect: check SSL is on and "Make it publicly available" is on in Coolify, and the database was restarted.'
  Write-Host "  If you changed the database's password since, delete $vpsFile and run this again."
  exit 1
}
if (-not $copy.encrypted) { throw 'The connection to the VPS database was not encrypted. In Coolify, turn on SSL for the database.' }
Write-Host ("  Copied in {0}s, encrypted: {1} contestants, {2} accounts, {3} votes, {4} payments." -f `
  $copy.seconds, $copy.contestants, $copy.accounts, $copy.votes, $copy.payments) -ForegroundColor Green

if ($Test) {
  Write-Host ''
  Write-Host 'Test done. The live site still uses Neon. When ready, run this again without -Test.'
  exit 0
}

# ---- 2. Switch ----
Write-Host ''
if (-not (Confirm-Step 'Switch the live site to the VPS database now?')) { exit 1 }
Write-Host 'Saving DATABASE_URL on Vercel...'
Set-VercelEnv 'DATABASE_URL' $url
# An earlier certificate setting would make the site insist on it, so it goes.
Set-VercelEnv 'DATABASE_CA_CERT' ''
Write-Host '  Saved' -ForegroundColor Green
Set-Region 'iad1'
Publish-Site

# ---- 3. Did anything reach Neon during the switch? ----
$after = Invoke-Helper 'scripts\check-db.mjs' @{ MBGN_CHECK_URL = $neon }
$missed = @()
foreach ($k in 'contestants', 'accounts', 'votes', 'payments') {
  if (-not $after.error -and $after.$k -gt $copy.$k) { $missed += "$($after.$k - $copy.$k) $k" }
}
Write-Host ''
if ($missed.Count) {
  Write-Host "These reached Neon after the copy and are not on the VPS: $($missed -join ', '). Tell your developer." -ForegroundColor Yellow
} else {
  Write-Host 'Nothing reached Neon after the copy. Nothing was missed.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Done. Now:' -ForegroundColor Green
Write-Host '  1. Resume voting in admin.'
Write-Host '  2. Commit vercel.json (now iad1), so later deploys keep the site next to the VPS.'
Write-Host '  Keep Neon for a week before deleting anything there. To go back: run this with -Back.'
