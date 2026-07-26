param(
    [string]$Executable = "native\color-core\build\Release\autocut_color_core_tests.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$testExecutable = if ([IO.Path]::IsPathRooted($Executable)) {
    $Executable
} else {
    Join-Path $root $Executable
}

if (!(Test-Path -LiteralPath $testExecutable -PathType Leaf)) {
    throw "Production color-core test executable not found: $testExecutable. Build native/color-core with CMake first."
}

& $testExecutable
if ($LASTEXITCODE -ne 0) {
    throw "Production color-core tests failed with exit code $LASTEXITCODE"
}
