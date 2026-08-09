param(
  [switch]$ProductionSigned,
  [switch]$UseExistingPackage
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (!$UseExistingPackage) {
  & (Join-Path $PSScriptRoot "package-extension.ps1")
  if ($LASTEXITCODE -ne 0) { throw "Package assembly failed" }
}
$setupExe = Join-Path $root "target\release\autocut_studio_setup.exe"
$finalExe = Join-Path $root "AutoCutStudioSetup.exe"
$env:AUTOCUT_PACKAGE_DIR = Join-Path $root "dist\com.autocutstudio.panel"
$features = "embedded-payload,development-unsigned"
if ($ProductionSigned) {
  $cepSignature = Join-Path $env:AUTOCUT_PACKAGE_DIR "META-INF\signatures.xml"
  $analyzer = Join-Path $env:AUTOCUT_PACKAGE_DIR "bin\beat_analyzer.exe"
  $nativePlugin = Join-Path $env:AUTOCUT_PACKAGE_DIR "native\MediaCore\AutoCutColorEngine.aex"
  if (!(Test-Path -LiteralPath $cepSignature)) {
    throw "Production build requires a signed CEP payload (missing META-INF\signatures.xml)."
  }
  $nativeSignature = Get-AuthenticodeSignature -LiteralPath $nativePlugin
  if ($nativeSignature.Status -ne "Valid") {
    throw "Production build requires a valid Authenticode signature on AutoCutColorEngine.aex."
  }
  $analyzerSignature = Get-AuthenticodeSignature -LiteralPath $analyzer
  if ($analyzerSignature.Status -ne "Valid") {
    throw "Production build requires a valid Authenticode signature on beat_analyzer.exe."
  }
  $features = "embedded-payload"
}
Push-Location $root
try {
  cargo build -p autocut_studio_setup --release --features $features
  if ($LASTEXITCODE -ne 0) { throw "Installer build failed" }
} finally { Pop-Location }
Copy-Item $setupExe $finalExe -Force
if ($ProductionSigned) {
  if (!$env:AUTOCUT_SIGNING_CERT_SHA1) {
    throw "Production build requires AUTOCUT_SIGNING_CERT_SHA1 to sign AutoCutStudioSetup.exe."
  }
  $signTool = Get-ChildItem (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin") -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
  if (!$signTool) { throw "Windows SDK signtool.exe is required for production signing." }
  & $signTool sign /sha1 $env:AUTOCUT_SIGNING_CERT_SHA1 /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $finalExe
  if ($LASTEXITCODE -ne 0) { throw "Installer Authenticode signing failed" }
  if ((Get-AuthenticodeSignature -LiteralPath $finalExe).Status -ne "Valid") {
    throw "Installer Authenticode signature verification failed."
  }
  Write-Host "Production setup created: $finalExe"
} else {
  Write-Warning "Development setup created with CEP debug mode support: $finalExe"
}
