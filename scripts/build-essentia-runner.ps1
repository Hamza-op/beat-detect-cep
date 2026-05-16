param(
  [string]$PythonPath = ""
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$toolPath = Join-Path $root "tools\essentia_beats.py"
$binDir = Join-Path $root "bin"
$distTemp = Join-Path $root "dist\pyinstaller-dist"
$buildTemp = Join-Path $root "dist\pyinstaller-build"
$specTemp = Join-Path $root "dist\pyinstaller-spec"
$outputExe = Join-Path $binDir "essentia_beats.exe"

function Resolve-Python {
  param([string]$Preferred)

  $candidates = @()
  if ($Preferred) {
    $candidates += @{ Command = $Preferred; Args = @() }
  }
  if ($env:BEATDETECT_PYTHON) {
    $candidates += @{ Command = $env:BEATDETECT_PYTHON; Args = @() }
  }
  $candidates += @{ Command = "python"; Args = @() }
  $candidates += @{ Command = "py"; Args = @("-3") }

  foreach ($candidate in $candidates) {
    try {
      $versionArgs = @($candidate.Args) + @("--version")
      $output = & $candidate.Command @versionArgs 2>&1
      if ($LASTEXITCODE -eq 0) {
        return $candidate
      }
      Write-Host "Python candidate failed: $($candidate.Command) $output"
    }
    catch {
      Write-Host "Python candidate unavailable: $($candidate.Command)"
    }
  }

  throw "Python was not found. Pass -PythonPath `"C:\Path\To\python.exe`" or set BEATDETECT_PYTHON."
}

function Run-Python {
  param(
    [hashtable]$Python,
    [string[]]$Args
  )

  $allArgs = @($Python.Args) + $Args
  & $Python.Command @allArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Python command failed: $($Python.Command) $($allArgs -join ' ')"
  }
}

if (!(Test-Path -LiteralPath $toolPath)) {
  throw "Missing Essentia runner source: $toolPath"
}

$python = Resolve-Python -Preferred $PythonPath

Write-Host "Checking Python Essentia and PyInstaller dependencies..."
Run-Python -Python $python -Args @("-c", "import essentia.standard; import PyInstaller; print('Essentia and PyInstaller: OK')")

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $distTemp | Out-Null
New-Item -ItemType Directory -Force -Path $buildTemp | Out-Null
New-Item -ItemType Directory -Force -Path $specTemp | Out-Null

Write-Host "Building bundled Essentia runner..."
Run-Python -Python $python -Args @(
  "-m", "PyInstaller",
  "--clean",
  "--onefile",
  "--name", "essentia_beats",
  "--distpath", $distTemp,
  "--workpath", $buildTemp,
  "--specpath", $specTemp,
  $toolPath
)

$builtExe = Join-Path $distTemp "essentia_beats.exe"
if (!(Test-Path -LiteralPath $builtExe)) {
  throw "PyInstaller finished but did not create $builtExe"
}

Copy-Item -LiteralPath $builtExe -Destination $outputExe -Force
Write-Host "Copied Essentia runner to $outputExe"
