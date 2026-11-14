# Connects the site to Evolution API, so it sends contestants their WhatsApp messages itself.
# Asks for Evolution's API key, checks it, saves the settings on Vercel, and deploys.
# From the project folder, signed in to Vercel (npx vercel login):
#   powershell -ExecutionPolicy Bypass -File scripts\whatsapp-site.ps1

param(
  [string]$EvolutionUrl = 'https://mbgn.useqitt.app',
  [string]$Instance = 'MBG Messager'
)

$ErrorActionPreference = 'Stop'
trap {
  Write-Host ''
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
Set-Location (Split-Path $PSScriptRoot -Parent)
$site = 'https://www.mbgn.com.ng'
$EvolutionUrl = $EvolutionUrl.Trim().TrimEnd('/')

Write-Host 'Paste Evolution''s API key.'
Write-Host '  Where: Coolify > Evolution API > Environment Variables > AUTHENTICATION_API_KEY'
Write-Host '  Right-click to paste. Nothing shows. Press Enter.'
$secure = Read-Host 'API key' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
if (-not $key) { throw 'No API key given.' }

$name = Read-Host "Instance name, as in Evolution's manager [$Instance]"
if ($name.Trim()) { $Instance = $name.Trim() }

Write-Host ''
Write-Host 'Checking...'
try {
  $r = Invoke-RestMethod "$EvolutionUrl/instance/connectionState/$([uri]::EscapeDataString($Instance))" -Headers @{ apikey = $key } -TimeoutSec 20
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 401 -or $code -eq 403) { throw 'Wrong API key.' }
  if ($code -eq 404) { throw "No instance called '$Instance'. Check the name in Evolution's manager." }
  throw "Couldn't reach $EvolutionUrl ($($_.Exception.Message))."
}
$state = if ($r.instance.state) { $r.instance.state } else { $r.state }
if ($state -eq 'open') { Write-Host 'Connected to WhatsApp.' -ForegroundColor Green }
else { Write-Host "The phone isn't connected ($state). Messages will wait until you reconnect it in Evolution's manager." -ForegroundColor Yellow }

Write-Host ''
Write-Host 'Saving on Vercel...'
foreach ($pair in @(@('EVOLUTION_URL', $EvolutionUrl), @('EVOLUTION_API_KEY', $key), @('EVOLUTION_INSTANCE', $Instance))) {
  # Through the keyboard input, so the key stays out of the shell history. Run through cmd,
  # because Windows PowerShell treats Vercel's progress messages as errors.
  cmd /c "npx vercel env rm $($pair[0]) production --yes >nul 2>&1"
  $pair[1] | npx vercel env add $pair[0] production | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Vercel did not accept $($pair[0]). Sign in with: npx vercel login. Then run this again." }
}
Write-Host '  Saved' -ForegroundColor Green

Write-Host ''
Write-Host 'Deploying the site (a minute or two)...'
npx vercel --prod --yes | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'The deploy failed. Run this command to try again:  npx vercel --prod --yes' }

Write-Host ''
Write-Host 'Done! The site now sends WhatsApp messages through Evolution API.' -ForegroundColor Green
Write-Host '  In admin: Messages > WhatsApp messages shows the status.'
Write-Host '  Accepted before today? Press "Message accepted contestants who haven''t had one" there.'
