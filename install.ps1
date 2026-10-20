[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$InstallDir = (Get-Location).Path,
    [string]$BaseUrl = 'https://github.com/aak1247/minitron/releases'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-ReleaseTag {
    param(
        [string]$RequestedVersion,
        [string]$ReleaseBaseUrl
    )

    if ($RequestedVersion -ne 'latest') {
        if ($RequestedVersion -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
            throw "Invalid version '$RequestedVersion'. Use a release tag such as v0.1.0."
        }
        return $RequestedVersion
    }

    $response = Invoke-WebRequest -UseBasicParsing -Uri "$ReleaseBaseUrl/latest" -MaximumRedirection 10 -Headers @{
        'User-Agent' = 'minitron-installer'
    }
    $finalUri = $null
    $baseResponse = $response.BaseResponse
    if ($null -ne $baseResponse -and $null -ne $baseResponse.PSObject.Properties['ResponseUri']) {
        $finalUri = $baseResponse.ResponseUri
    }
    if ($null -eq $finalUri -and $null -ne $baseResponse -and $null -ne $baseResponse.PSObject.Properties['RequestMessage']) {
        $finalUri = $baseResponse.RequestMessage.RequestUri
    }
    $releaseRoot = [Uri]$ReleaseBaseUrl
    $tagPrefix = $releaseRoot.AbsolutePath.TrimEnd('/') + '/tag/'
    if ($null -eq $finalUri -or -not $finalUri.AbsolutePath.StartsWith($tagPrefix, [StringComparison]::Ordinal)) {
        throw "Could not resolve the latest release tag from '$ReleaseBaseUrl/latest'."
    }

    $tag = [Uri]::UnescapeDataString($finalUri.AbsolutePath.Substring($tagPrefix.Length))
    if ([string]::IsNullOrWhiteSpace($tag) -or $tag.Contains('/') -or $tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "The latest release returned an invalid tag '$tag'."
    }
    return $tag
}

function Get-ReleaseFileUrl {
    param(
        [string]$ReleaseBaseUrl,
        [string]$Tag,
        [string]$FileName
    )

    $escapedTag = [Uri]::EscapeDataString($Tag)
    return "$ReleaseBaseUrl/download/$escapedTag/$FileName"
}

function Save-ReleaseFile {
    param(
        [string]$Uri,
        [string]$Destination
    )

    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination -Headers @{
            'User-Agent' = 'minitron-installer'
        }
    }
    catch {
        throw "Could not download '$Uri': $($_.Exception.Message)"
    }
}

function Get-ExpectedSha256 {
    param(
        [string]$ManifestPath,
        [string]$FileName
    )

    $hashes = @()
    foreach ($line in Get-Content -LiteralPath $ManifestPath) {
        if ($line -match '^\s*([A-Fa-f0-9]{64})\s+\*?(.+?)\s*$' -and $Matches[2] -ceq $FileName) {
            $hashes += $Matches[1].ToLowerInvariant()
        }
    }

    if ($hashes.Count -ne 1) {
        throw "SHA256SUMS must contain exactly one valid checksum for '$FileName'."
    }
    return $hashes[0]
}

$workingDir = $null
$exitCode = 0
try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'This installer is for Windows. Run install.sh on Linux or macOS.'
    }

    $architecture = $null
    try {
        $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    }
    catch {
        $architecture = $env:PROCESSOR_ARCHITEW6432
        if ([string]::IsNullOrWhiteSpace($architecture)) {
            $architecture = $env:PROCESSOR_ARCHITECTURE
        }
    }
    if ($architecture -notin @('AMD64', 'x64', 'X64')) {
        $shownArchitecture = if ([string]::IsNullOrWhiteSpace($architecture)) { 'unknown' } else { $architecture }
        throw "Windows architecture '$shownArchitecture' is not published. Supported target: Windows x64."
    }

    if ($BaseUrl -notmatch '^https?://[^?#]+$') {
        throw "BaseUrl must be an absolute HTTP or HTTPS URL without a query or fragment."
    }
    $BaseUrl = $BaseUrl.TrimEnd('/')

    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $tag = Get-ReleaseTag -RequestedVersion $Version -ReleaseBaseUrl $BaseUrl
    $assetName = "minitron-$tag-windows-x64.zip"
    $releaseDir = Join-Path ([IO.Path]::GetTempPath()) ("minitron-install-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
    $workingDir = $releaseDir

    $archivePath = Join-Path $releaseDir $assetName
    $manifestPath = Join-Path $releaseDir 'SHA256SUMS'
    Save-ReleaseFile -Uri (Get-ReleaseFileUrl -ReleaseBaseUrl $BaseUrl -Tag $tag -FileName 'SHA256SUMS') -Destination $manifestPath
    Save-ReleaseFile -Uri (Get-ReleaseFileUrl -ReleaseBaseUrl $BaseUrl -Tag $tag -FileName $assetName) -Destination $archivePath

    $expectedHash = Get-ExpectedSha256 -ManifestPath $manifestPath -FileName $assetName
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $archiveStream = [IO.File]::OpenRead($archivePath)
    try {
        $actualHash = [BitConverter]::ToString($sha256.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $archiveStream.Dispose()
        $sha256.Dispose()
    }
    if ($actualHash -cne $expectedHash) {
        throw "SHA-256 verification failed for '$assetName'; refusing to install."
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $extractedBinary = Join-Path $releaseDir 'minitron.exe'
    $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entries = @($zip.Entries)
        if ($entries.Count -ne 1 -or $entries[0].FullName -cne 'minitron.exe') {
            throw 'The release archive must contain only the root-level minitron.exe binary.'
        }

        $inputStream = $entries[0].Open()
        try {
            $outputStream = [IO.File]::Create($extractedBinary)
            try {
                $inputStream.CopyTo($outputStream)
            }
            finally {
                $outputStream.Dispose()
            }
        }
        finally {
            $inputStream.Dispose()
        }
    }
    finally {
        $zip.Dispose()
    }

    if ((Get-Item -LiteralPath $extractedBinary).Length -eq 0) {
        throw 'The minitron.exe binary in the release archive is empty.'
    }

    $targetDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
    if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) {
        New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }
    $targetBinary = Join-Path $targetDir 'minitron.exe'
    if (Test-Path -LiteralPath $targetBinary -PathType Container) {
        throw "Cannot install because '$targetBinary' is a directory."
    }

    $stagedBinary = Join-Path $targetDir ('.minitron.exe.install-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        Copy-Item -LiteralPath $extractedBinary -Destination $stagedBinary
        Move-Item -LiteralPath $stagedBinary -Destination $targetBinary -Force
    }
    finally {
        if (Test-Path -LiteralPath $stagedBinary) {
            Remove-Item -LiteralPath $stagedBinary -Force
        }
    }

    Write-Host "Installed minitron to: $targetBinary"
    Write-Host "Keep minitron.toml and application resources in: $targetDir"
}
catch {
    [Console]::Error.WriteLine("Installation failed: $($_.Exception.Message)")
    $exitCode = 1
}
finally {
    if ($null -ne $workingDir -and (Test-Path -LiteralPath $workingDir)) {
        Remove-Item -LiteralPath $workingDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($exitCode -ne 0) {
    exit $exitCode
}
