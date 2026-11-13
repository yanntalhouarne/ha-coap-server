<#
.SYNOPSIS
    Creates your private MCUboot signing key (ECDSA P-256) for this firmware.

.DESCRIPTION
    Writes application\keys\mcuboot-signing-key.pem (ignored by git), which every build then
    uses: MCUboot embeds its public half, and update images are signed with it. Boards only
    accept updates signed with the key their bootloader was built with.

    Back the key up somewhere safe (password manager, encrypted drive). Without it you can't
    update your boards over USB or the air anymore, only reflash them over SWD.

    Refuses to overwrite an existing key. Run scripts\setup.ps1 first.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\keygen.ps1
#>
param(
    [string]$NcsVersion = "v2.4.3"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$key = Join-Path $repo "application\keys\mcuboot-signing-key.pem"

if (Test-Path $key) {
    throw "$key already exists. Replacing it would lock out boards that use it; delete it yourself if you really mean to."
}

$nrfutil = (Get-Command nrfutil -ErrorAction SilentlyContinue).Source
if (-not $nrfutil) {
    $nrfutil = Join-Path $env:LOCALAPPDATA "Programs\nrfutil\nrfutil.exe"
}
if (-not (Test-Path $nrfutil)) {
    throw "nrfutil not found. Run scripts\setup.ps1 first."
}

New-Item -ItemType Directory -Force (Split-Path $key) | Out-Null
& $nrfutil toolchain-manager launch --ncs-version $NcsVersion --chdir $repo -- python external/bootloader/mcuboot/scripts/imgtool.py keygen -k $key -t ecdsa-p256
if ($LASTEXITCODE -ne 0) {
    throw "Key generation failed (exit code $LASTEXITCODE)"
}

Write-Host ""
Write-Host "Created $key"
Write-Host "Back it up now: you need this exact file to update boards flashed with it."
Write-Host "Next builds are signed with it. Flash each board once over SWD so its bootloader trusts it."
