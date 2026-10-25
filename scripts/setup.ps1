<#
.SYNOPSIS
    Prepares this repository for building on Windows.

.DESCRIPTION
    1. Finds nrfutil, or downloads it to %LOCALAPPDATA%\Programs\nrfutil (signature checked).
    2. Installs the nrfutil toolchain-manager command and the nRF Connect SDK toolchain.
    3. Fetches the pinned SDK (application/west.yml) into external/ with 'west update'.

    Safe to run again, for example after the SDK pin in application/west.yml changes.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#>
param(
    [string]$NcsVersion = "v2.4.3"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$nrfutilUrl = "https://files.nordicsemi.com/ui/api/v1/download?repoKey=swtools&path=external/nrfutil/executables/x86_64-pc-windows-msvc/nrfutil.exe&isNativeBrowsing=false"
$nrfutilLocal = Join-Path $env:LOCALAPPDATA "Programs\nrfutil\nrfutil.exe"

function Invoke-Checked {
    param([string]$What, [scriptblock]$Command)
    Write-Host "==> $What"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$What failed (exit code $LASTEXITCODE)"
    }
}

# 1. nrfutil
$nrfutil = (Get-Command nrfutil -ErrorAction SilentlyContinue).Source
if (-not $nrfutil -and (Test-Path $nrfutilLocal)) {
    $nrfutil = $nrfutilLocal
}
if (-not $nrfutil) {
    Write-Host "==> Downloading nrfutil to $nrfutilLocal"
    New-Item -ItemType Directory -Force (Split-Path $nrfutilLocal) | Out-Null
    $download = "$nrfutilLocal.download"
    Invoke-WebRequest -Uri $nrfutilUrl -OutFile $download -UseBasicParsing
    $signature = Get-AuthenticodeSignature $download
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Nordic Semiconductor") {
        Remove-Item $download
        throw "The downloaded nrfutil.exe is not signed by Nordic Semiconductor ($($signature.Status)). Install it manually from https://www.nordicsemi.com/Products/Development-tools/nRF-Util"
    }
    Move-Item -Force $download $nrfutilLocal
    $nrfutil = $nrfutilLocal
}
Write-Host "Using nrfutil: $nrfutil"

# 2. Toolchain
if (-not ((& $nrfutil list) -match "toolchain-manager")) {
    Invoke-Checked "Installing the nrfutil toolchain-manager command" { & $nrfutil install toolchain-manager }
}
if (-not ((& $nrfutil toolchain-manager list) -match [regex]::Escape($NcsVersion))) {
    Invoke-Checked "Installing the nRF Connect SDK $NcsVersion toolchain (large download)" {
        & $nrfutil toolchain-manager install --ncs-version $NcsVersion
    }
}
else {
    Write-Host "==> Toolchain $NcsVersion already installed"
}

# 3. SDK
Invoke-Checked "Fetching the SDK into external/ (west update)" {
    & $nrfutil toolchain-manager launch --ncs-version $NcsVersion --chdir $repo -- west update --narrow "-o=--depth=1"
}

Write-Host ""
Write-Host "Setup done. Build the firmware with:"
Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\build.ps1"
Write-Host "or open the repository in VS Code with the nRF Connect extension."
