$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$analyzerDir = Join-Path $root "analyzer"
$binDir = Join-Path $root "bin"
$exePath = Join-Path $analyzerDir "target\release\beat_analyzer.exe"
$destPath = Join-Path $binDir "beat_analyzer.exe"

Push-Location $analyzerDir
try {
  cargo build --release
  if ($LASTEXITCODE -ne 0) {
    throw "cargo build --release failed for analyzer"
  }
}
finally {
  Pop-Location
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item -LiteralPath $exePath -Destination $destPath -Force
Write-Host "Copied analyzer to $destPath"
