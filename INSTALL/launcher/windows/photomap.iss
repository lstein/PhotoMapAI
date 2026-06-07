; Inno Setup script for the PhotoMapAI launcher.
; Produces a per-user installer (no admin/UAC) that drops the small signed
; launcher exe and creates Start Menu / desktop shortcuts. The heavy Python +
; PyTorch stack is fetched by the launcher (via uv) on first run, not bundled.
;
; The version and source exe path are passed in from CI:
;   iscc /DAppVersion=1.2.3 /DSourceExe=dist\photomap.exe photomap.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceExe
  #define SourceExe "dist\photomap.exe"
#endif

#define AppName "PhotoMapAI"
#define AppExe "photomap.exe"
#define AppPublisher "Lincoln Stein"

[Setup]
AppId={{8F2A6C71-3E4B-4D9A-9C2E-5B7A1D6F0E33}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; Per-user install: no administrator rights required.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=dist
OutputBaseFilename=PhotoMapAI-{#AppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\..\..\photomap\frontend\static\icons\favicon.ico
UninstallDisplayIcon={app}\{#AppExe}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "{#AppExe}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
