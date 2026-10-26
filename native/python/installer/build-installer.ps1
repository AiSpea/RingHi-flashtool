param([string]$Compiler = "$env:LOCALAPPDATA\RingHi-BuildTools\InnoSetup\ISCC.exe")
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$version=& "$root/.venv/Scripts/python.exe" -c 'from ringhi import __version__; print(__version__)'
if($LASTEXITCODE -ne 0){throw 'Cannot read app version'}
if(-not(Test-Path "$root/dist/RingHi/RingHi.exe")){throw 'Build application first'}
& $Compiler "/DAppVersion=$version" "$PSScriptRoot/RingHi.iss"
if($LASTEXITCODE -ne 0){throw 'Installer compilation failed'}
$exe="$root/releases/RingHi-Setup-$version-win-x64.exe"
$zip="$root/releases/RingHi-Python-$version-win-x64.zip"
Compress-Archive -Path "$root/dist/RingHi" -DestinationPath $zip -Force
@($exe,$zip)|ForEach-Object { ((Get-FileHash $_ -Algorithm SHA256).Hash.ToLower()+'  '+(Split-Path $_ -Leaf)) }|Set-Content "$root/releases/SHA256SUMS.txt" -Encoding ASCII
Get-Item $exe,$zip|Select-Object Name,Length
