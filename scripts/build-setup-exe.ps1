$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot "package-extension.ps1")
if ($LASTEXITCODE -ne 0) { throw "Package assembly failed" }
$setupExe = Join-Path $root "target\release\autocut_studio_setup.exe"
$finalExe = Join-Path $root "AutoCutStudioSetup.exe"
$env:AUTOCUT_PACKAGE_DIR = Join-Path $root "dist\com.autocutstudio.panel"
Push-Location $root
try {
  cargo build -p autocut_studio_setup --release --features embedded-payload
  if ($LASTEXITCODE -ne 0) { throw "Installer build failed" }
} finally { Pop-Location }
Copy-Item $setupExe $finalExe -Force
Write-Host "Unsigned setup created: $finalExe"
