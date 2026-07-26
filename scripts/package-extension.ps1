$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$extensionId = "com.autocutstudio.panel"
$distRoot = Join-Path $root "dist"
$packageDir = Join-Path $distRoot $extensionId
$nativeBuildDir = Join-Path $root "native\MediaCore"
$nativeProject = Join-Path $root "native\premiere-plugin\Win\AutoCutColorEngine.vcxproj"
$nativePlugin = Join-Path $nativeBuildDir "AutoCutColorEngine.aex"

& (Join-Path $PSScriptRoot "build-windows.ps1")
if ($LASTEXITCODE -ne 0) { throw "Analyzer build failed" }

if (!(Test-Path -LiteralPath $nativePlugin)) {
  throw "Release native plugin is missing: $nativePlugin. Build it with the prepared Windows/MSVC toolchain."
}

Push-Location $root
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Panel build failed" }
} finally { Pop-Location }

New-Item -ItemType Directory -Force (Join-Path $packageDir "bin"),(Join-Path $packageDir "native\MediaCore") | Out-Null
Copy-Item (Join-Path $root "bin\beat_analyzer.exe") (Join-Path $packageDir "bin\beat_analyzer.exe")
Copy-Item $nativePlugin (Join-Path $packageDir "native\MediaCore\AutoCutColorEngine.aex")
Set-Content -LiteralPath (Join-Path $packageDir "INSTALL.txt") -Value "AutoCut Studio 1.1.0 (unsigned Windows build). Copy this directory to the Adobe CEP extensions folder." -Encoding UTF8

node (Join-Path $root "tools\package\assemble.mjs")
node (Join-Path $root "tools\verify\payload.mjs")
Write-Host "Ready-to-copy extension created: $packageDir"
