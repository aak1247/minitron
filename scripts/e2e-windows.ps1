param(
    [string]$RuntimeZip,
    [string]$RuntimeVersion = '32.2.0',
    [string]$UpgradeRuntimeZip,
    [string]$UpgradeRuntimeVersion = '33.3.1',
    [string]$ShellBinary,
    [string]$NewShellBinary,
    [string]$NativeAsar,
    [string]$CargoHome,
    [string]$Report
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $RuntimeZip) {
    $RuntimeZip = (Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron/Cache') -Recurse -Filter "electron-v$RuntimeVersion-win32-x64.zip" | Select-Object -First 1).FullName
}
if (-not $UpgradeRuntimeZip) {
    $UpgradeRuntimeZip = (Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron/Cache') -Recurse -Filter "electron-v$UpgradeRuntimeVersion-win32-x64.zip" | Select-Object -First 1).FullName
}
if (-not $ShellBinary) { $ShellBinary = Join-Path $repoRoot 'shell/target/release/electron-shell.exe' }
foreach ($file in @($RuntimeZip, $UpgradeRuntimeZip, $ShellBinary)) {
    if (-not $file -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing E2E input $file. Build the launcher and pass official runtime ZIP paths." }
}
if (-not $NewShellBinary) {
    $previousVersion = $env:ERS_BUILD_VERSION
    $previousCargoHome = $env:CARGO_HOME
    $env:ERS_BUILD_VERSION = '0.1.1'
    if ($CargoHome) { $env:CARGO_HOME = $CargoHome }
    Push-Location (Join-Path $repoRoot 'shell')
    try {
        & cargo build --locked
        if ($LASTEXITCODE -ne 0) { throw 'Updated-shell fixture build failed' }
        $toolDir = Join-Path $repoRoot 'dist/test-tools'
        New-Item -ItemType Directory -Force -Path $toolDir | Out-Null
        $NewShellBinary = Join-Path $toolDir 'shell-0.1.1.exe'
        Copy-Item -LiteralPath (Join-Path $repoRoot 'shell/target/debug/electron-shell.exe') -Destination $NewShellBinary -Force
    } finally { Pop-Location; $env:ERS_BUILD_VERSION = $previousVersion; $env:CARGO_HOME = $previousCargoHome }
}
if (-not $Report) { $Report = Join-Path $repoRoot 'dist/e2e-report.json' }
$testArgs = @((Join-Path $PSScriptRoot 'e2e.mjs'), '--runtime-zip', $RuntimeZip, '--runtime-version', $RuntimeVersion, '--upgrade-runtime-zip', $UpgradeRuntimeZip, '--upgrade-runtime-version', $UpgradeRuntimeVersion, '--shell', $ShellBinary, '--new-shell', $NewShellBinary, '--report', $Report)
if ($NativeAsar) { $testArgs += @('--native-asar', $NativeAsar) }
& node @testArgs
if ($LASTEXITCODE -ne 0) { throw 'End-to-end verification failed; inspect the JSON report and logs.' }
