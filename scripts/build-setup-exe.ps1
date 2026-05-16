param(
  [switch]$WithEssentia,
  [string]$PythonPath = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$installerDir = Join-Path $root "installer"
$setupExe = Join-Path $installerDir "target\release\beat_detect_setup.exe"
$finalExe = Join-Path $root "BeatDetectSetup.exe"

if ($WithEssentia) {
  & (Join-Path $PSScriptRoot "build-essentia-runner.ps1") -PythonPath $PythonPath
}

& (Join-Path $PSScriptRoot "package-extension.ps1")

Push-Location $installerDir
try {
  cargo build --release
  if ($LASTEXITCODE -ne 0) {
    throw "cargo build --release failed for setup"
  }
}
finally {
  Pop-Location
}

Copy-Item -LiteralPath $setupExe -Destination $finalExe -Force
Write-Host "Single-file setup created:"
Write-Host "  $finalExe"
