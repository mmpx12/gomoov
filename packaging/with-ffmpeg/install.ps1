$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
if (-not (Test-Path -Path ".\gomoov.exe")) {
	throw "gomoov.exe is not in this folder."
}
$dest = Join-Path $env:LOCALAPPDATA "gomoov"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force ".\gomoov.exe" (Join-Path $dest "gomoov.exe")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) { $userPath = "" }
$parts = $userPath.Split(";") | Where-Object { $_ -ne "" }
if ($parts -notcontains $dest) {
	$updated = if ($userPath) { "$userPath;$dest" } else { $dest }
	[Environment]::SetEnvironmentVariable("Path", $updated, "User")
	Write-Host "Added $dest to your user PATH. Open a new terminal before running gomoov."
}
Write-Host "Installed $(Join-Path $dest 'gomoov.exe')"
Write-Host "ffmpeg and ffprobe are inside this build. The first run unpacks them to $env:USERPROFILE\.gomoov\bin."
Write-Host "From your movie folder: gomoov"
Write-Host "With accounts: gomoov -U"
