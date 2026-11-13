<#
.SYNOPSIS
    Builds the firmware with the nRF Connect SDK toolchain (run scripts\setup.ps1 once first).

.DESCRIPTION
    Variants:
      battery       Production firmware: sleepy end device, updates over USB and over Thread.
                    Output in application\build (where the update scripts look).
      usb-logging   Adds the console and logs on a second USB serial port.
      uart-console  Adds the console and logs on the J4 UART.
      debug         Adds asserts, -Og and thread info, for a debugger.
    Other variants are built in application\build_<variant>. Every build starts from a clean
    build directory, so stale settings never carry over. Extra arguments are passed to CMake
    (quote any that contain a dot or a semicolon).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 usb-logging
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 battery -DCONFIG_HACOAP_SENSOR_SAMPLE_PERIOD_S=900
#>
param(
    [ValidateSet("battery", "usb-logging", "uart-console", "debug")]
    [string]$Variant = "battery",
    [string]$NcsVersion = "v2.4.3",
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CMakeArgs = @()
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

$variants = @{
    "battery"      = @()
    "usb-logging"  = @("-DEXTRA_CONF_FILE=overlay-logging.conf;overlay-usb.conf", "-DEXTRA_DTC_OVERLAY_FILE=boards/usb-console.overlay")
    "uart-console" = @("-DEXTRA_CONF_FILE=overlay-uart.conf;overlay-logging.conf", "-DEXTRA_DTC_OVERLAY_FILE=boards/uart.overlay")
    "debug"        = @("-DEXTRA_CONF_FILE=overlay-debug.conf")
}
$buildDir = if ($Variant -eq "battery") { "application/build" } else { "application/build_" + $Variant.Replace("-", "_") }

$nrfutil = (Get-Command nrfutil -ErrorAction SilentlyContinue).Source
if (-not $nrfutil) {
    $nrfutil = Join-Path $env:LOCALAPPDATA "Programs\nrfutil\nrfutil.exe"
}
if (-not (Test-Path $nrfutil)) {
    throw "nrfutil not found. Run scripts\setup.ps1 first."
}

$westArgs = @("build", "-p", "always", "-d", $buildDir, "application", "--") + $variants[$Variant] + $CMakeArgs
& $nrfutil toolchain-manager launch --ncs-version $NcsVersion --chdir $repo -- west @westArgs
if ($LASTEXITCODE -ne 0) {
    throw "Build failed (exit code $LASTEXITCODE)"
}

Write-Host ""
Write-Host "Firmware update image: $buildDir/zephyr/app_update.bin"
Write-Host "Full image for SWD:    $buildDir/zephyr/merged.hex"
