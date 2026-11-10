# Takes the site live: saves Paystack's LIVE keys on Vercel and deploys. After this, votes cost
# real money. See "Going live" in README.md.
#
# Run it from the project folder, signed in to Vercel (npx vercel login):
#   powershell -ExecutionPolicy Bypass -File scripts\paystack-live.ps1
#
# The keys and password are typed in hidden and go straight to Vercel. They are never written to a file.

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Read-Secret([string]$prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

# Replaces a production setting on Vercel. The value goes in through the keyboard input, not the
# command line, so it does not end up in the shell history.
function Set-VercelSetting([string]$name, [string]$value) {
  # Removing a setting that is not there yet is fine. Run through cmd, because Windows PowerShell
  # would treat Vercel's progress messages as errors once they are hidden.
  cmd /c "npx vercel env rm $name production --yes >nul 2>&1"
  $value | npx vercel env add $name production | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Vercel did not accept $name. Check you are signed in (npx vercel login) and try again." }
  Write-Host "  Saved $name" -ForegroundColor Green
}

Write-Host ''
Write-Host 'This takes MBGN live with real money. On its first start, the live site will:' -ForegroundColor Yellow
Write-Host '  - remove the invented demo contestants and their accounts'
Write-Host '  - remove every vote, payment and admin vote change so far (all test money)'
Write-Host '  - keep real applicants, back at zero votes'
Write-Host '  - go back to registration, with a fresh 7-day countdown an admin can change'
Write-Host ''
Write-Host 'Back up the database first: in the Neon console, Branches > Create branch from main.' -ForegroundColor Yellow
$go = Read-Host 'Type GO LIVE to continue, or press Enter to stop'
if ($go -ne 'GO LIVE') { Write-Host 'Stopped. Nothing was changed.'; exit 0 }

Write-Host ''
Write-Host 'Paste your keys from the Paystack dashboard: Settings > API Keys & Webhooks, in Live mode.'
$secret = Read-Secret 'Live SECRET key (starts sk_live_)'
if ($secret -notmatch '^sk_live_[A-Za-z0-9]+$') { throw 'That is not a live secret key. It must start with sk_live_. Nothing was changed.' }
$public = Read-Secret 'Live PUBLIC key (starts pk_live_)'
if ($public -notmatch '^pk_live_[A-Za-z0-9]+$') { throw 'That is not a live public key. It must start with pk_live_. Nothing was changed.' }

# Paystack needs a customer email on every payment, and supporters are not asked for one, so each
# payment uses this mailbox with its reference added. The live site will not start without it.
$email = (Read-Host 'Mailbox for payment emails (Enter for payment@mbgn.com.ng)').Trim()
if (-not $email) { $email = 'payment@mbgn.com.ng' }
if ($email -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'That email address does not look right. Nothing was changed.' }

# The admin login. The live site sets it from these settings on its next start, and again whenever
# they change, so this is also how to get back in after a forgotten password.
Write-Host ''
$adminEmail = ''
$adminPassword = ''
$loginFile = '.secrets\admin-login.txt'
if (Test-Path $loginFile) {
  $saved = Get-Content $loginFile -Raw
  $savedEmail = [regex]::Match($saved, '(?m)^Email:\s*(\S+)').Groups[1].Value
  $savedPassword = [regex]::Match($saved, '(?m)^Password:\s*(\S+)').Groups[1].Value
  if ($savedEmail -and $savedPassword -and (Read-Host "Use the admin login in $loginFile ($savedEmail)? (y/n)") -eq 'y') {
    $adminEmail = $savedEmail
    $adminPassword = $savedPassword
  }
}
if (-not $adminEmail) {
  Write-Host 'New admin login. Press Enter to skip and keep the current one.'
  $adminEmail = (Read-Host 'Admin email').Trim()
  if ($adminEmail) {
    if ($adminEmail -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') { throw 'That admin email does not look right. Nothing was changed.' }
    $adminPassword = Read-Secret 'Admin password (at least 12 characters; long and hard to guess)'
    if ($adminPassword.Length -lt 12 -or $adminPassword -eq 'admin-demo-pass') { throw 'Choose a password of at least 12 characters, not the demo one. Nothing was changed.' }
    if ((Read-Secret 'Admin password again') -ne $adminPassword) { throw 'The two passwords do not match. Nothing was changed.' }
  }
}

Write-Host ''
Write-Host 'Saving to Vercel (production)...'
Set-VercelSetting 'PAYSTACK_SECRET_KEY' $secret
# Not used by the site today (checkout happens on Paystack's own page), kept for anything added later.
Set-VercelSetting 'PAYSTACK_PUBLIC_KEY' $public
Set-VercelSetting 'PAYMENT_EMAIL' $email
if ($adminEmail) {
  Set-VercelSetting 'ADMIN_EMAIL' $adminEmail
  Set-VercelSetting 'ADMIN_PASSWORD' $adminPassword
}
$secret = $null; $public = $null; $adminPassword = $null

# The site's own address, used in voting links, emails and Paystack's return page. The domain is
# already connected in Vercel, with mbgn.com.ng redirecting to www.
$siteUrl = 'https://www.mbgn.com.ng'
Set-VercelSetting 'PUBLIC_URL' $siteUrl

Write-Host ''
Write-Host 'Deploying the live site...'
npx vercel --prod --yes
if ($LASTEXITCODE -ne 0) { throw 'The deploy failed. Your settings are saved; run npx vercel --prod --yes to try again.' }

Write-Host ''
Write-Host 'Done. Now:' -ForegroundColor Green
Write-Host "  1. In the Paystack dashboard (Live mode), set the webhook URL to $siteUrl/api/webhooks/paystack"
Write-Host "  2. Open $siteUrl/admin, sign in, and on the Competition tab set the registration countdown,"
Write-Host '     check the prices and add a WhatsApp group.'
Write-Host "  3. Save the admin login from $loginFile in a password manager, then delete that file."
