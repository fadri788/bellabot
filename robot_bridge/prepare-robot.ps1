#Requires -Version 7.2
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$LaptopIp,
    [Parameter(Mandatory = $true)][string]$RobotIp,
    [Parameter(Mandatory = $true)][string]$RobotMac,
    [string]$ReturnDestination = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
function Confirm-RobotNeighbour {
    param([string]$LaptopAddress, [string]$RobotAddress, [string]$ExpectedMac)
    if (-not $IsWindows) { return }
    if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $LaptopAddress)) {
        throw 'Laptop address is not assigned to this computer.'
    }
    if (-not ('BellaDashboardArp' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BellaDashboardArp {
    [DllImport("iphlpapi.dll", ExactSpelling=true)]
    public static extern int SendARP(uint destination, uint source, byte[] mac, ref uint length);
}
'@
    }
    $source = [BitConverter]::ToUInt32([System.Net.IPAddress]::Parse($LaptopAddress).GetAddressBytes(), 0)
    $destination = [BitConverter]::ToUInt32([System.Net.IPAddress]::Parse($RobotAddress).GetAddressBytes(), 0)
    $mac = New-Object byte[] 6
    [uint32]$length = 6
    $result = [BellaDashboardArp]::SendARP($destination, $source, $mac, [ref]$length)
    if ($result -ne 0 -or $length -ne 6 -or [BitConverter]::ToString($mac) -ine $ExpectedMac.Replace(':', '-')) {
        throw 'Robot MAC does not match this address on this network. No configuration was changed.'
    }
}
foreach ($address in @($LaptopIp, $RobotIp)) {
    $parsed = [System.Net.IPAddress]::Parse($address)
    $bytes = $parsed.GetAddressBytes()
    if ($bytes.Length -ne 4 -or -not ($bytes[0] -eq 10 -or
        ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) { throw 'Explicit private IPv4 addresses required.' }
}
if ($LaptopIp -eq $RobotIp -or $RobotMac -notmatch '^(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$') { throw 'Different laptop and robot addresses and a valid confirmed MAC are required.' }
if ($ReturnDestination.Length -gt 128 -or $ReturnDestination -match '[\x00-\x1f\x7f]') { throw 'Invalid return destination.' }
$projectRoot = Split-Path $PSScriptRoot -Parent
$folder = Join-Path $projectRoot '.robot-runtime'
$ruleName = 'BellaDashboardLocal8443'
if ($DryRun -or $WhatIfPreference) {
    Write-Output 'Dry run: no files, certificate, firewall or network settings changed.'
    Write-Output 'Would save this laptop configuration, verify the robot MAC, and create a seven-day private listener certificate.'
    Write-Output 'On Windows, would allow only the selected robot to reach Node on this laptop, TCP 8443.'
    return
}
if (-not $PSCmdlet.ShouldProcess('Local robot configuration and listener', 'Prepare the robot connection')) { return }
Confirm-RobotNeighbour -LaptopAddress $LaptopIp -RobotAddress $RobotIp -ExpectedMac $RobotMac
$config = @{ laptopIp = $LaptopIp; robotIp = $RobotIp; robotMac = $RobotMac; returnDestination = $ReturnDestination }
$config | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectRoot '.robot-local.json') -Encoding utf8
Push-Location -LiteralPath $projectRoot
try {
    & node -e 'const bridge = require("./robot_bridge"); bridge.verifyIdentity(bridge.loadConfig());'
    if ($LASTEXITCODE -ne 0) { throw 'Robot identity check failed. No certificate or firewall rule was changed.' }
} finally { Pop-Location }
[System.IO.Directory]::CreateDirectory($folder) | Out-Null
$rsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=Bella dashboard local listener', $rsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress([System.Net.IPAddress]::Parse($LaptopIp))
    $san.AddIpAddress([System.Net.IPAddress]::Loopback)
    $request.CertificateExtensions.Add($san.Build())
    $usages = [System.Security.Cryptography.OidCollection]::new()
    $usages.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
    $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $false))
    $expires = [DateTimeOffset]::UtcNow.AddDays(7)
    $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), $expires)
    try {
        $passphrase = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
        $pfx = $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $passphrase)
        @{ host = $LaptopIp; expiresAt = $expires.ToString('o'); pfx = [Convert]::ToBase64String($pfx); passphrase = $passphrase } |
            ConvertTo-Json | Set-Content -LiteralPath (Join-Path $folder 'listener-certificate.json') -Encoding utf8
    } finally { $certificate.Dispose() }
} finally { $rsa.Dispose() }
if ($IsWindows) {
    $nodePath = (Get-Command node -CommandType Application).Source
    $existing = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if ($existing) {
        $existing | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort 8443 -LocalAddress $LaptopIp -RemoteAddress $RobotIp -Program $nodePath | Out-Null
    } else {
        New-NetFirewallRule -Name $ruleName -DisplayName 'Bella dashboard (one robot, TCP 8443)' -Enabled True -Direction Inbound -Action Allow -Profile Any -Protocol TCP -LocalPort 8443 -LocalAddress $LaptopIp -RemoteAddress $RobotIp -Program $nodePath | Out-Null
    }
} else {
    Write-Output 'Check local firewall access for the chosen robot to TCP 8443 before starting the listener.'
}
Write-Output 'Prepared local configuration and certificate. Private material stays in ignored local files. No robot setting or movement command was sent.'
