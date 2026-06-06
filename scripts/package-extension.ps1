$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$extensionId = "com.autocutstudio.panel"
$distRoot = Join-Path $root "dist"
$packageDir = Join-Path $distRoot $extensionId
$nativeProject = Join-Path $root "native\premiere_plugin\Win\AutoCutColorEngine.vcxproj"
$nativeBuildDir = Join-Path $root "native\MediaCore"
$nativePlugin = Join-Path $nativeBuildDir "AutoCutColorEngine.aex"

function Find-MSBuild {
  $fromPath = Get-Command "msbuild.exe" -ErrorAction SilentlyContinue
  if ($fromPath) {
    return $fromPath.Source
  }

  $vswhereCandidates = @()
  $programFilesX86 = ${env:ProgramFiles(x86)}
  if ($programFilesX86) {
    $vswhereCandidates += Join-Path $programFilesX86 "Microsoft Visual Studio\Installer\vswhere.exe"
  }
  if ($env:ProgramFiles) {
    $vswhereCandidates += Join-Path $env:ProgramFiles "Microsoft Visual Studio\Installer\vswhere.exe"
  }
  $vswhereCandidates += "D:\Program Files\Microsoft Visual Studio\Installer\vswhere.exe"
  $vswhereCandidates = $vswhereCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($vswhere in $vswhereCandidates) {
    $found = @(& $vswhere -latest -products * -requires Microsoft.Component.MSBuild -find "MSBuild\**\Bin\MSBuild.exe") | Select-Object -First 1
    if ($found -and (Test-Path -LiteralPath $found)) {
      return $found
    }
  }

  $msbuildCandidates = @(
    "D:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\amd64\MSBuild.exe",
    "D:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe"
  )
  foreach ($candidate in $msbuildCandidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  return $null
}

function Get-AvailablePlatformToolsets {
  param([string]$MSBuildPath)

  if (-not $MSBuildPath -or -not (Test-Path -LiteralPath $MSBuildPath)) {
    return @()
  }

  $vcRoots = @()
  if ($env:VCTargetsPath) {
    $vcRoots += $env:VCTargetsPath.TrimEnd("\")
  }

  $msbuildBin = Split-Path -Parent $MSBuildPath
  $msbuildRoot = Split-Path -Parent (Split-Path -Parent $msbuildBin)
  $vcRoots += Join-Path $msbuildRoot "Microsoft\VC"
  $vcRoots += "D:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Microsoft\VC\v180"

  $vcRoots = $vcRoots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
  if (-not $vcRoots -or $vcRoots.Count -eq 0) {
    return @()
  }

  $toolsets = foreach ($vcRoot in $vcRoots) {
    Get-ChildItem -LiteralPath $vcRoot -Recurse -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Parent -and $_.Parent.Name -eq "PlatformToolsets" -and $_.Name -match '^v\d+$' } |
      Select-Object -ExpandProperty Name
  }

  $toolsets = $toolsets | Select-Object -Unique

  $preferred = @("v145", "v143", "v142", "v141")
  $ordered = @()
  foreach ($toolset in $preferred) {
    if ($toolsets -contains $toolset) {
      $ordered += $toolset
    }
  }
  foreach ($toolset in ($toolsets | Sort-Object -Descending)) {
    if ($ordered -notcontains $toolset) {
      $ordered += $toolset
    }
  }
  return $ordered
}

function Get-NativeSourceNewestWriteTimeUtc {
  $sourceRoots = @(
    (Join-Path $root "native\premiere_plugin"),
    (Join-Path $root "native\color_engine")
  )

  $sourceFiles = foreach ($sourceRoot in $sourceRoots) {
    Get-ChildItem -LiteralPath $sourceRoot -Recurse -File |
      Where-Object { $_.Extension -in ".cpp", ".h", ".r", ".vcxproj", ".sln" }
  }

  $newest = $sourceFiles | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if ($newest) {
    return $newest.LastWriteTimeUtc
  }
  return [DateTime]::MinValue
}

function Build-NativeColorPlugin {
  Write-Host "Building native color plugin..."
  New-Item -ItemType Directory -Force -Path $nativeBuildDir | Out-Null

  $msbuild = Find-MSBuild
  $sourceNewest = Get-NativeSourceNewestWriteTimeUtc
  $pluginExists = Test-Path -LiteralPath $nativePlugin
  $pluginIsCurrent = $pluginExists -and ((Get-Item -LiteralPath $nativePlugin).LastWriteTimeUtc -ge $sourceNewest)

  if ($msbuild) {
    $toolsets = Get-AvailablePlatformToolsets $msbuild
    if (-not $toolsets -or $toolsets.Count -eq 0) {
      $toolsets = @("v143")
    }

    $attempts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($toolset in $toolsets) {
      Write-Host "Using MSVC platform toolset $toolset"
      & $msbuild $nativeProject "/p:Configuration=Release" "/p:Platform=x64" "/p:PlatformToolset=$toolset" "/p:AE_PLUGIN_BUILD_DIR=$nativeBuildDir"
      if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $nativePlugin)) {
        return
      }
      $attempts.Add($toolset)
    }

    throw "MSBuild failed for native color plugin. Tried platform toolsets: $($attempts -join ', ')"
  }

  if (-not $pluginIsCurrent) {
    throw "MSBuild was not found and native color plugin is missing or older than source. Install Visual Studio Build Tools 2022 or newer with MSBuild, then rerun this script."
  }

  Write-Warning "MSBuild was not found; packaging the existing native plugin at $nativePlugin."
}

Write-Host "Building analyzer..."
& (Join-Path $PSScriptRoot "build-windows.ps1")

Build-NativeColorPlugin

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

$nativeSource = $nativeBuildDir
if (Test-Path -LiteralPath $nativeSource) {
  $nativeFiles = Get-ChildItem -LiteralPath $nativeSource -Recurse -File | Where-Object { $_.Name -ne ".gitkeep" }
  if ($nativeFiles.Count -gt 0) {
    New-Item -ItemType Directory -Force -Path (Join-Path $packageDir "native") | Out-Null
    Copy-Item -LiteralPath $nativeSource -Destination (Join-Path $packageDir "native") -Recurse -Force
  }
}

$installText = @"
AutoCut Studio install

Copy this whole folder:
  $extensionId

Into Adobe CEP extensions, usually:
  C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\

Final path should look like:
  C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\$extensionId\CSXS\manifest.xml

If it does not appear in Premiere under Window -> Extensions -> AutoCut Studio,
enable unsigned CEP extensions for your Premiere/CEP version:

  reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f

Some Premiere versions use another CSXS number, such as CSXS.10 or CSXS.12.
Restart Premiere after changing this setting.
"@

Set-Content -LiteralPath (Join-Path $packageDir "INSTALL.txt") -Value $installText -Encoding UTF8

Write-Host "Ready-to-copy extension created:"
Write-Host "  $packageDir"
