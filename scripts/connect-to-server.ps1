# Prepares this Windows machine to open the HA-CoAP server (its VM) in VS Code over SSH.
#
#   1. Makes this machine's SSH key for it (~/.ssh/hacoap-server), unless it has one.
#   2. Adds "hacoap" (over ZeroTier: from anywhere) and "hacoap-lan" (the home network) to ~/.ssh/config.
#   3. Prints the one command to run on a machine that can already connect, which lets this one in
#      (the server only takes keys it knows, no passwords).
#
# Then: VS Code, Remote-SSH: Connect to Host > hacoap, and open ~/ha-coap-server.
# Over ZeroTier, this machine must have joined your ZeroTier network. Safe to run again.
#
# Usage: scripts\connect-to-server.ps1 [-ZeroTier 10.243.120.130] [-Lan 192.168.50.178] [-User hacoap]

param(
    [string]$ZeroTier = "10.243.120.130",
    [string]$Lan = "192.168.50.178",
    [string]$User = "hacoap"
)
$ErrorActionPreference = "Stop"

# The server's own key, to check on the first connection (ssh asks to trust it)
$Fingerprint = "SHA256:QrVf83X9noTSwHB7HFWQsz/DJrmV4RTVVRxQGoPpzc8"

$sshDir = Join-Path $HOME ".ssh"
$key = Join-Path $sshDir "hacoap-server"
$config = Join-Path $sshDir "config"
New-Item -ItemType Directory -Force $sshDir | Out-Null

if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    throw "OpenSSH isn't installed: Settings > System > Optional features > OpenSSH Client"
}

# 1. The key
if (Test-Path $key) {
    Write-Host "This machine's key: $key (already there)"
} else {
    $comment = "$env:USERNAME@$env:COMPUTERNAME for hacoap"
    # No passphrase: an empty argument, which older PowerShell only passes on as '""'
    $passing = (Get-Variable PSNativeCommandArgumentPassing -ErrorAction SilentlyContinue).Value
    $empty = if ($passing -in 'Standard', 'Windows') { '' } else { '""' }
    & ssh-keygen -q -t ed25519 -N $empty -C $comment -f $key
    if ($LASTEXITCODE -ne 0) { throw "ssh-keygen failed" }
    Write-Host "Made this machine's key: $key"
}

# 2. The hosts
$existing = if (Test-Path $config) { Get-Content $config -Raw } else { "" }
if ($existing -match "(?m)^Host hacoap\s*$") {
    Write-Host "~/.ssh/config already has hacoap"
} else {
    $entry = @"

# The HA-CoAP server (its VM, user $User). VS Code: Remote-SSH: Connect to Host > hacoap.
# Over ZeroTier, so from anywhere; hacoap-lan is the same server on the home network.
Host hacoap
  HostName $ZeroTier
  User $User
  IdentityFile ~/.ssh/hacoap-server
  IdentitiesOnly yes

Host hacoap-lan
  HostName $Lan
  User $User
  IdentityFile ~/.ssh/hacoap-server
  IdentitiesOnly yes
"@
    Add-Content -Path $config -Value $entry -Encoding ascii
    Write-Host "Added hacoap and hacoap-lan to $config"
}

# 3. Letting it in
$public = (Get-Content "$key.pub" -Raw).Trim()
Write-Host ""
Write-Host "Now, on a machine that can already connect (or in the VM's console in Proxmox), run:"
Write-Host ""
Write-Host "  ssh hacoap `"grep -qxF '$public' ~/.ssh/authorized_keys || echo '$public' >> ~/.ssh/authorized_keys`""
Write-Host ""
Write-Host "Then test it here: ssh hacoap hostname"
Write-Host "The first time, ssh shows the server's key: it must be $Fingerprint"
