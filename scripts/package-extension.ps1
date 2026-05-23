$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$extensionId = "com.beatdetect.spikemarker"
$distRoot = Join-Path $root "dist"
$packageDir = Join-Path $distRoot $extensionId

Write-Host "Building analyzer..."
& (Join-Path $PSScriptRoot "build-windows.ps1")

if (Test-Path -LiteralPath $packageDir) {
  Remove-Item -LiteralPath $packageDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $packageDir | Out-Null

$items = @(
  "CSXS",
  "css",
  "js",
  "jsx",
  "index.html"
)

foreach ($item in $items) {
  $source = Join-Path $root $item
  $destination = Join-Path $packageDir $item
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

$packageBinDir = Join-Path $packageDir "bin"
New-Item -ItemType Directory -Force -Path $packageBinDir | Out-Null
Copy-Item -LiteralPath (Join-Path $root "bin\beat_analyzer.exe") -Destination (Join-Path $packageBinDir "beat_analyzer.exe") -Force

$installText = @"
Beat Detect install

Copy this whole folder:
  $extensionId

Into Adobe CEP extensions, usually:
  C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\

Final path should look like:
  C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\$extensionId\CSXS\manifest.xml

If it does not appear in Premiere under Window -> Extensions -> Beat Detect,
enable unsigned CEP extensions for your Premiere/CEP version:

  reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f

Some Premiere versions use another CSXS number, such as CSXS.10 or CSXS.12.
Restart Premiere after changing this setting.
"@

Set-Content -LiteralPath (Join-Path $packageDir "INSTALL.txt") -Value $installText -Encoding UTF8

Write-Host "Ready-to-copy extension created:"
Write-Host "  $packageDir"
