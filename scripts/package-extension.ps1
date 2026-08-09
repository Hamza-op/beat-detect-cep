$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$extensionId = "com.autocutstudio.panel"
$distRoot = Join-Path $root "dist"
$packageDir = Join-Path $distRoot $extensionId
$nativeBuildDir = Join-Path $root "native\MediaCore"
$nativeProject = Join-Path $root "native\premiere-plugin\Win\AutoCutColorEngine.vcxproj"
$nativePlugin = Join-Path $nativeBuildDir "AutoCutColorEngine.aex"
$product = Get-Content -LiteralPath (Join-Path $root "config\product.json") -Raw | ConvertFrom-Json

Push-Location $root
try {
  node (Join-Path $root "tools\build\generate-metadata.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Product metadata generation failed" }
} finally { Pop-Location }

& (Join-Path $PSScriptRoot "build-windows.ps1")
if ($LASTEXITCODE -ne 0) { throw "Analyzer build failed" }

$msbuild = $env:MSBUILD_EXE_PATH
if (!$msbuild) {
  $msbuildCommand = Get-Command msbuild.exe -ErrorAction SilentlyContinue
  if ($msbuildCommand) { $msbuild = $msbuildCommand.Source }
}
if (!$msbuild) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswhere) {
    $msbuild = & $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe" | Select-Object -First 1
  }
}
if (!$msbuild -or !(Test-Path -LiteralPath $msbuild)) {
  throw "MSBuild with the Visual C++ workload is required; refusing to package a stale native plugin."
}

New-Item -ItemType Directory -Force $nativeBuildDir | Out-Null
& $msbuild $nativeProject /t:Build /p:Configuration=Release /p:Platform=x64 /p:TreatWarningsAsErrors=true "/p:AE_PLUGIN_BUILD_DIR=$nativeBuildDir"
if ($LASTEXITCODE -ne 0) { throw "Native color plugin build failed" }
if (!(Test-Path -LiteralPath $nativePlugin)) { throw "Native build did not create $nativePlugin" }

Push-Location $root
try {
  node (Join-Path $root "tools\build\panel.mjs")
  if ($LASTEXITCODE -ne 0) { throw "Panel build failed" }
} finally { Pop-Location }

New-Item -ItemType Directory -Force (Join-Path $packageDir "bin"),(Join-Path $packageDir "native\MediaCore") | Out-Null
Copy-Item (Join-Path $root "bin\beat_analyzer.exe") (Join-Path $packageDir "bin\beat_analyzer.exe")
Copy-Item $nativePlugin (Join-Path $packageDir "native\MediaCore\AutoCutColorEngine.aex")
Set-Content -LiteralPath (Join-Path $packageDir "INSTALL.txt") -Value "AutoCut Studio $($product.version) Windows build. Install with AutoCutStudioSetup.exe; development builds require CEP debug mode." -Encoding UTF8

node (Join-Path $root "tools\package\assemble.mjs")
node (Join-Path $root "tools\verify\payload.mjs")
Write-Host "Ready-to-copy extension created: $packageDir"
