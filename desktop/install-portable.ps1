param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$config=Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$stage=$null
try {
  if(-not [IO.Path]::IsPathRooted($config.target) -or [IO.Path]::GetExtension($config.target) -ne '.exe'){throw 'Invalid portable application path'}
  # Only wait for the old app. Never terminate it or bypass its CSV/flash guard.
  for($attempt=0;$attempt -lt 120;$attempt++){
    if(-not (Get-Process -Id $config.pid -ErrorAction SilentlyContinue)){break}
    Start-Sleep -Milliseconds 500
  }
  if(Get-Process -Id $config.pid -ErrorAction SilentlyContinue){throw 'Old application did not exit; original application preserved'}
  if((Get-FileHash -LiteralPath $config.source -Algorithm SHA256).Hash -ne $config.sha256){throw 'Update package checksum mismatch'}
  if((Get-FileHash -LiteralPath $config.target -Algorithm SHA256).Hash -ne $config.oldSha256){throw 'Original application changed; refusing overwrite'}
  $stage=$config.target+'.'+[Guid]::NewGuid().ToString('N')+'.update'
  $backup=$config.target+'.previous'
  Copy-Item -LiteralPath $config.source -Destination $stage
  if((Get-FileHash -LiteralPath $stage -Algorithm SHA256).Hash -ne $config.sha256){throw 'Staged package checksum mismatch'}
  # NSIS portable launcher may hold the EXE briefly after Electron exits.
  $replaced=$false
  for($attempt=0;$attempt -lt 120;$attempt++){
    try {
      if((Get-FileHash -LiteralPath $config.target -Algorithm SHA256).Hash -ne $config.oldSha256){throw 'Original application changed'}
      [IO.File]::Replace($stage,$config.target,$backup)
      $replaced=$true;break
    } catch [IO.IOException] {Start-Sleep -Milliseconds 500}
  }
  if(-not $replaced){throw 'Application file remains locked; original application preserved'}
  if((Get-FileHash -LiteralPath $config.target -Algorithm SHA256).Hash -ne $config.sha256){[IO.File]::Replace($backup,$config.target,($config.target+'.failed-update'));throw 'Installed checksum mismatch; rolled back'}
  @{ok=$true;version=$config.version;path=$config.target;finishedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $config.result -Encoding UTF8
  Start-Process -FilePath $config.target
} catch {
  @{ok=$false;error=$_.Exception.Message;path=$config.target} | ConvertTo-Json | Set-Content -LiteralPath $config.result -Encoding UTF8
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show(('RingHi update failed. Original app or .previous backup is retained.'+[Environment]::NewLine+$_.Exception.Message),'RingHi') | Out-Null
} finally {
  if($stage -and (Test-Path -LiteralPath $stage)){Remove-Item -LiteralPath $stage -Force}
}
