# wsl-localhost-proxy.ps1
#
# Makes http://localhost:8080 on Windows reach the WSL2 dev server, so the
# browser can load the page AND grant mic access (mic requires localhost/https).
#
# Usage (from an ADMIN PowerShell):
#   powershell -ExecutionPolicy Bypass -File .\wsl-localhost-proxy.ps1
#
# Re-run after a WSL reboot (the WSL IP changes).
# Remove the proxy with:  netsh interface portproxy reset
#
param(
    [int]$Port = 8080
)

$ip = (wsl -e hostname -I) -split '\s' | Select-Object -First 1
if (-not $ip) {
    Write-Error "Could not get the WSL IP. Is a WSL distro running? (try: wsl -l -v)"
    exit 1
}

Write-Host "Proxying localhost:$Port  ->  $ip:$Port" -ForegroundColor Cyan
netsh interface portproxy add v4tov4 `
    listenaddress=127.0.0.1 listenport=$Port `
    connectaddress=$ip connectport=$Port

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "Done. Next steps:"
    Write-Host "  1. In WSL:  python3 -m http.server $Port"
    Write-Host "  2. Browser: http://localhost:$Port"
    Write-Host "  (If it fails: Test-NetConnection $ip -Port $Port | netstat -ano | findstr :$Port)"
} else {
    Write-Error "netsh failed. Run this PowerShell as Administrator."
}
