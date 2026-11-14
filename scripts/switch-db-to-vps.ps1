# Moves the live site's database from Neon to the one Coolify runs on your VPS, in one go:
#   1. fetches the VPS database's certificate authority (public, not a secret)
#   2. checks the site can reach the VPS database, encrypted, with the copied data in it
#   3. keeps Neon's address in .secrets\, so you can switch back with -Back
#   4. saves DATABASE_URL and DATABASE_CA_CERT on Vercel
#   5. moves the site's server code to Washington DC, next to the VPS, and deploys
# Nothing on Vercel changes until the check in step 2 passes.
#
# Before: pause voting in admin, then run copy-from-neon.sh on the VPS. Then, from the project
# folder, signed in to Vercel (npx vercel login):
#   powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1 -Server root@YOUR_VPS_IP
# After: resume voting in admin, and on the VPS run:  bash copy-from-neon.sh check
#
# To go back to Neon:
#   powershell -ExecutionPolicy Bypass -File scripts\switch-db-to-vps.ps1 -Back
#
# Options:
#   -Port 2222    if your VPS's SSH is not on port 22
#   -CheckOnly    only do steps 1 and 2 (safe at any time: nothing changes)

param(
  [string]$Server = '',
  [int]$Port = 22,
  [switch]$Back,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$site = 'https://www.mbgn.com.ng'
$neonFile = '.secrets\neon-database-url.txt'
$caFile = '.secrets\coolify-ca.crt'
New-Item -ItemType Directory -Force '.secrets' | Out-Null

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

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Confirm-Step([string]$Question) {
  (Read-Host "$Question [y/N]") -match '^[Yy]'
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

if ($Server -notmatch '^[^@\s]+@[^@\s]+$') {
  throw 'Give your VPS login as -Server user@address, for example -Server root@203.0.113.10'
}

# ---- 1. The certificate authority ----
Write-Host ''
Write-Host "Fetching the database's certificate authority from $Server..."
$ca = (ssh -p $Port $Server 'cat /data/coolify/ssl/coolify-ca.crt') -join "`n"
if ($LASTEXITCODE -ne 0 -or $ca -notmatch 'BEGIN CERTIFICATE') {
  throw "Couldn't read /data/coolify/ssl/coolify-ca.crt on the VPS. In Coolify, turn on SSL for the database, then run this again."
}
[IO.File]::WriteAllText((Join-Path (Resolve-Path '.secrets') 'coolify-ca.crt'), $ca + "`n")
Write-Host "  Got it (also saved in $caFile)." -ForegroundColor Green

# ---- 2. Can the site reach it? ----
Write-Host ''
$raw = Read-Secret "Paste Coolify's 'Postgres URL (public)' for the database (it stays hidden)"
$url = ([regex]::Match($raw, 'postgres(ql)?://[^''"\s]+')).Value
if (-not $url) { throw "That doesn't look like a database address. It starts with postgres://" }
$hostName = ([regex]::Match($url, '^postgres(?:ql)?://[^@/]+@([^:/?#]+)')).Groups[1].Value
if ($hostName -notmatch '\.') {
  throw "That's the internal address, which only works inside the VPS. In Coolify, turn on 'Make it publicly available' and copy the public one."
}
# The MBGN data is in the "mbgn" database that copy-from-neon.sh made, not in "postgres".
$url = $url -replace '^(postgres(?:ql)?://[^/?#]+)(/[^?#]*)?', '$1/mbgn'

Write-Host 'Connecting the way the site will...'
$env:MBGN_CHECK_URL = $url
$env:MBGN_CHECK_CA = $ca
try {
  $out = (node scripts\check-db.mjs | Out-String).Trim()
} finally {
  Remove-Item Env:MBGN_CHECK_URL, Env:MBGN_CHECK_CA -ErrorAction SilentlyContinue
}
$info = try { $out | ConvertFrom-Json } catch { [pscustomobject]@{ error = $out } }
if ($info.error) {
  Write-Host "  Couldn't connect: $($info.error)" -ForegroundColor Red
  Write-Host '  Check the address and password, that the database is publicly available, and that SSL is on.'
  exit 1
}
if (-not $info.encrypted) { throw 'The connection was not encrypted. In Coolify, turn on SSL for the database.' }
if (-not $info.hasData) { throw "The VPS database has no MBGN data yet. Run copy-from-neon.sh on the VPS first." }
Write-Host ("  Connected, encrypted. PostgreSQL {0}. {1} contestants, {2} accounts, {3} votes, {4} payments." -f `
  $info.version, $info.contestants, $info.accounts, $info.votes, $info.payments) -ForegroundColor Green
Write-Host ("  A query from here takes {0} ms (from Vercel's Washington servers it will be far quicker)." -f $info.queryMs)
if ($info.maxConnections -lt 150) {
  Write-Host "  Note: the database allows only $($info.maxConnections) connections. In Coolify, add max_connections = 200 to its custom PostgreSQL configuration." -ForegroundColor Yellow
}
if ($CheckOnly) { exit 0 }

# ---- 3. Keep Neon's address, for going back ----
if (-not (Test-Path $neonFile)) {
  $pulled = Join-Path ([IO.Path]::GetTempPath()) "mbgn-env-$([guid]::NewGuid().ToString('N')).txt"
  try {
    cmd /c "npx vercel env pull `"$pulled`" --environment=production --yes >nul 2>&1"
    $line = if (Test-Path $pulled) { Get-Content $pulled | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1 } else { $null }
    $current = if ($line) { ($line -replace '^DATABASE_URL=', '').Trim().Trim('"') } else { '' }
  } finally {
    # The pulled file holds every production secret, so it goes straight away.
    Remove-Item -Force $pulled -ErrorAction SilentlyContinue
  }
  if ($current -notmatch 'neon\.tech') {
    Write-Host ''
    Write-Host "Couldn't read Neon's address from Vercel, and it's needed to switch back if anything goes wrong."
    $current = Read-Secret "Paste Neon's connection string to keep it (or press Enter to go on without)"
  }
  if ($current) {
    [IO.File]::WriteAllText((Join-Path (Resolve-Path '.secrets') 'neon-database-url.txt'), $current + "`n")
    Write-Host "  Neon's address kept in $neonFile, for -Back." -ForegroundColor Green
  }
}

# ---- 4 and 5. Switch ----
Write-Host ''
Write-Host 'Ready to switch the live site to the VPS database.'
Write-Host 'Only do this right after pausing voting and running copy-from-neon.sh, or anything newer on Neon is left behind.' -ForegroundColor Yellow
if (-not (Confirm-Step 'Switch now?')) { exit 1 }

Write-Host 'Saving DATABASE_URL and DATABASE_CA_CERT on Vercel...'
Set-VercelEnv 'DATABASE_URL' $url
# On one line, with its line breaks written as \n; the site turns them back.
Set-VercelEnv 'DATABASE_CA_CERT' ($ca.Trim() -replace "`r?`n", '\n')
Write-Host '  Saved' -ForegroundColor Green
Set-Region 'iad1'
Publish-Site

Write-Host ''
Write-Host 'Done. Now:' -ForegroundColor Green
Write-Host '  1. Resume voting in admin.'
Write-Host "  2. On the VPS, check nothing was left behind on Neon:  ssh -t $Server `"bash copy-from-neon.sh check`""
Write-Host '  3. Commit vercel.json (now iad1), so later deploys keep the site next to the VPS.'
Write-Host '  Keep Neon for a week before deleting anything there.'
