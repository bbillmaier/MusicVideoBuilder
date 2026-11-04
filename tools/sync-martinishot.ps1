# Copies the MartiniShot node pack from the local ComfyUI install into this repo,
# so the cloud setup script (cloud/runpod/setup.sh) installs the same code.
# The ComfyUI copy is where the nodes are developed; run this before committing.
#
#   powershell -ExecutionPolicy Bypass -File tools\sync-martinishot.ps1
#   powershell -ExecutionPolicy Bypass -File tools\sync-martinishot.ps1 -ComfyUI "D:\Other\ComfyUI"

param(
    [string]$ComfyUI = "E:\LTX2-Install\ComfyUI_windows_portable\ComfyUI"
)

$src = Join-Path $ComfyUI "custom_nodes\MartiniShot"
$dst = Join-Path $PSScriptRoot "..\comfyui\custom_nodes\MartiniShot"

if (-not (Test-Path $src)) { Write-Error "MartiniShot not found at $src"; exit 1 }

# requirements.txt is kept in the repo copy only, so it is excluded from the mirror.
robocopy $src $dst /MIR /XD __pycache__ /XF *.pyc requirements.txt /NJH /NP /NDL
if ($LASTEXITCODE -ge 8) { Write-Error "robocopy failed ($LASTEXITCODE)"; exit 1 }
Write-Host "MartiniShot synced to $((Resolve-Path $dst).Path)"
exit 0
