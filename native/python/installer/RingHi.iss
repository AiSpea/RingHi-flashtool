#ifndef AppVersion
  #define AppVersion "0.5.14"
#endif
[Setup]
AppId=com.aispea.ringhi.python
AppName=RingHi
AppVerName=RingHi
AppVersion={#AppVersion}
AppPublisher=AiSpea
DefaultDirName={code:InstallFolder}
DefaultGroupName=RingHi
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\releases
OutputBaseFilename=RingHi-Setup-{#AppVersion}-win-x64
SetupIconFile=..\assets\app.ico
UninstallDisplayIcon={app}\RingHi.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
AppMutex=Local\RingHi.Native.Workstation
CloseApplications=no
RestartApplications=no
SetupLogging=yes
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
[Files]
Source: "..\dist\RingHi\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{userprograms}\RingHi"; Filename: "{app}\RingHi.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\RingHi"; Filename: "{app}\RingHi.exe"; WorkingDir: "{app}"
[Registry]
Root: HKCU; Subkey: "Software\AiSpea\RingHi"; ValueType: string; ValueName: "InstallPath"; ValueData: "{app}"; Flags: uninsdeletekey
[Run]
Filename: "{app}\RingHi.exe"; Description: "Open RingHi"; Flags: nowait postinstall skipifsilent
[Code]
function InstallFolder(Param: String): String;
var Existing: String;
begin
  if RegQueryStringValue(HKCU, 'Software\AiSpea\RingHi', 'InstallPath', Existing) and FileExists(Existing + '\RingHi.exe') then
    Result := Existing
  else if FileExists(ExpandConstant('{userdesktop}\RingHi-Native-Preview\RingHi.exe')) then
    Result := ExpandConstant('{userdesktop}\RingHi-Native-Preview')
  else
    Result := ExpandConstant('{localappdata}\Programs\RingHi');
end;
