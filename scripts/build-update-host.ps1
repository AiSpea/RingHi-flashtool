$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\desktop\update-host.cs'
$output=Join-Path $PSScriptRoot '..\desktop\update-host.exe'
$csc=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /optimize+ /platform:anycpu ('/out:'+$output) $source
if($LASTEXITCODE -ne 0){throw 'Update host compilation failed'}
Get-FileHash $output -Algorithm SHA256
