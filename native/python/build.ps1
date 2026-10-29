param([string]$Output = "$PSScriptRoot\dist")
$ErrorActionPreference='Stop'
$py="$PSScriptRoot\.venv\Scripts\python.exe"
& $py -m pytest "$PSScriptRoot\tests" -q
if($LASTEXITCODE -ne 0){throw 'Software regression failed'}
& $py -m PyInstaller --noconfirm --clean --windowed --onedir --name RingHi --icon "$PSScriptRoot\assets\app.ico" --distpath $Output --workpath "$PSScriptRoot\build" --specpath "$PSScriptRoot\build" --add-data "$PSScriptRoot\assets;assets" --add-data "$PSScriptRoot\Tools;Tools" --hidden-import tests.ui_check --exclude-module pytest --exclude-module tkinter "$PSScriptRoot\main.py"
if($LASTEXITCODE -ne 0){throw 'PyInstaller failed'}
# macOS source archives may contain AppleDouble metadata; never distribute it.
Get-ChildItem "$Output\RingHi" -Recurse -File -Filter '._*' | Remove-Item -Force
& $py -m pip freeze | Set-Content "$Output\RingHi\DEPENDENCIES.txt" -Encoding UTF8
Copy-Item "$PSScriptRoot\README.md" "$Output\RingHi" -Force
Write-Output "Built $Output\RingHi\RingHi.exe"
$licenses="$Output\RingHi\LICENSES"
New-Item -ItemType Directory -Force $licenses|Out-Null
Get-ChildItem "$PSScriptRoot\.venv\Lib\site-packages" -Directory -Filter '*.dist-info'|ForEach-Object {
 $destination=Join-Path $licenses $_.Name
 New-Item -ItemType Directory -Force $destination|Out-Null
 Get-ChildItem $_.FullName -Recurse -File|Where-Object {$_.Name -match 'LICENSE|COPYING|NOTICE|AUTHORS'}|ForEach-Object {Copy-Item $_.FullName $destination -Force}
}
