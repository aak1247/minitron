param(
    [string]$AppVersion,
    [string]$RuntimeVersion = '32.2.0',
    [string]$AppId = 'com.example.myapp',
    [string]$AppName = 'MyApp',
    [Parameter(Mandatory = $true)][string]$ManifestUrl,
    [string]$ManifestPublicKey,
    [switch]$AllowLocalhostHttp,
    [ValidateSet('Debug', 'Release')][string]$Configuration = 'Release',
    [string]$CargoHome,
    [string]$ShellBinary,
    [string]$OutputDirectory,
    [string]$Makensis,
    [switch]$SkipAppBuild,
    [switch]$SkipRustBuild,
    [switch]$SkipInstaller
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $AppVersion) { $AppVersion = (Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'app/package.json') | ConvertFrom-Json).version }
if ($AppVersion -notmatch '^\d+\.\d+\.\d+$' -or $RuntimeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'App and runtime versions must be exact stable x.y.z values.' }
if ($AppId -notmatch '^[a-zA-Z0-9._-]+$' -or $AppName -notmatch '^[a-zA-Z0-9 ._-]+$') { throw 'Invalid application identifier or name.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot "dist/windows/$AppVersion" }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$staging = Join-Path $OutputDirectory 'application'
$resources = Join-Path $OutputDirectory 'resources'
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

Push-Location (Join-Path $repoRoot 'app')
try {
    if (-not $SkipAppBuild) {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
        & npm.cmd run pack:asar -- --runtime-version $RuntimeVersion --version $AppVersion --out $resources
        if ($LASTEXITCODE -ne 0) { throw 'Application resource build failed' }
    }
} finally { Pop-Location }

if (-not $SkipRustBuild -and -not $ShellBinary) {
    $previousCargoHome = $env:CARGO_HOME
    if ($CargoHome) { $env:CARGO_HOME = $CargoHome }
    Push-Location (Join-Path $repoRoot 'shell')
    try {
        $buildArgs = @('build', '--locked')
        if ($Configuration -eq 'Release') { $buildArgs += '--release' }
        & cargo @buildArgs
        if ($LASTEXITCODE -ne 0) { throw 'Rust launcher build failed' }
    } finally { Pop-Location; $env:CARGO_HOME = $previousCargoHome }
}
if (-not $ShellBinary) { $ShellBinary = Join-Path $repoRoot "shell/target/$($Configuration.ToLowerInvariant())/minitron.exe" }
if (-not (Test-Path -LiteralPath $ShellBinary -PathType Leaf)) { throw "Missing launcher: $ShellBinary" }
if (-not (Test-Path -LiteralPath (Join-Path $resources 'app.asar') -PathType Leaf)) { throw "Missing resources: $resources" }
# Only named resources are copied, so the source ZIP and build tooling cannot enter the application.
$targetResources = [IO.Path]::GetFullPath((Join-Path $staging 'resources'))
$stagingBoundary = [IO.Path]::GetFullPath($staging).TrimEnd('\') + '\'
if (-not $targetResources.StartsWith($stagingBoundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging resources path' }
if (Test-Path -LiteralPath $targetResources) { Remove-Item -LiteralPath $targetResources -Recurse -Force }
New-Item -ItemType Directory -Force -Path $targetResources | Out-Null
Copy-Item -LiteralPath $ShellBinary -Destination (Join-Path $staging 'minitron.exe') -Force
Copy-Item -LiteralPath (Join-Path $resources 'app.asar') -Destination (Join-Path $staging 'resources/app.asar') -Force
$unpacked = Join-Path $resources 'app.asar.unpacked'
if (Test-Path -LiteralPath $unpacked -PathType Container) { Copy-Item -LiteralPath $unpacked -Destination (Join-Path $staging 'resources') -Recurse -Force }
$toml = @(
    ('app_id = ' + (ConvertTo-Json -Compress $AppId)),
    ('required_runtime = ' + (ConvertTo-Json -Compress $RuntimeVersion)),
    ('app_version = ' + (ConvertTo-Json -Compress $AppVersion)),
    ('manifest_url = ' + (ConvertTo-Json -Compress $ManifestUrl)),
    ('allow_localhost_http = ' + $AllowLocalhostHttp.IsPresent.ToString().ToLowerInvariant())
)
if ($ManifestPublicKey) { $toml += 'manifest_public_key = ' + (ConvertTo-Json -Compress $ManifestPublicKey) }
[IO.File]::WriteAllText((Join-Path $staging 'minitron.toml'), ($toml -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
$unexpectedRuntime = Get-ChildItem -LiteralPath $staging -Recurse -File | Where-Object { $_.Name -in @('electron.exe', 'icudtl.dat', 'chrome_100_percent.pak') }
if ($unexpectedRuntime) { throw 'The application package unexpectedly contains Electron runtime files.' }

$installerPath = Join-Path $OutputDirectory "$AppName-Setup-$AppVersion.exe"
if (-not $SkipInstaller) {
    if (-not $Makensis) {
        $available = Get-Command makensis.exe -ErrorAction SilentlyContinue
        if ($available) { $Makensis = $available.Source }
        else {
            $cache = Join-Path $env:LOCALAPPDATA 'electron-builder/Cache/nsis'
            $candidate = Get-ChildItem -LiteralPath $cache -Filter makensis.exe -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -First 1
            if ($candidate) { $Makensis = $candidate.FullName }
        }
    }
    if (-not $Makensis) { throw 'NSIS makensis.exe is required. Install NSIS or pass -Makensis <path>.' }
    & $Makensis '/V2' "/DAPP_ID=$AppId" "/DAPP_NAME=$AppName" "/DAPP_VERSION=$AppVersion" "/DRUNTIME_VER=$RuntimeVersion" "/DSTAGING_DIR=$staging" "/DOUTPUT_FILE=$installerPath" (Join-Path $repoRoot 'installer/myapp.nsi')
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installerPath)) { throw 'NSIS installer build failed' }
}
$summary = [ordered]@{ application = $staging; resources = $resources; installer = $(if ($SkipInstaller) { $null } else { $installerPath }); appVersion = $AppVersion; runtimeVersion = $RuntimeVersion }
$summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'build.json') -Encoding utf8
$summary | ConvertTo-Json
