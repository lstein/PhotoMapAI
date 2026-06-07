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
#ifndef VCRedist
  #define VCRedist "dist\vc_redist.x64.exe"
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
SetupIconFile=..\icons\photomap.ico
UninstallDisplayIcon={app}\photomap.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "{#AppExe}"; Flags: ignoreversion
; Launcher icon used by the Start Menu / desktop shortcuts (the Go exe has no
; embedded icon, so shortcuts reference this file).
Source: "..\icons\photomap.ico"; DestDir: "{app}"; Flags: ignoreversion
; Bundled VC++ runtime installer; only extracted when the runtime is missing.
Source: "{#VCRedist}"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: VCRedistNeeded

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\photomap.ico"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; IconFilename: "{app}\photomap.ico"; Tasks: desktopicon

[Run]
; PyTorch needs the Microsoft Visual C++ runtime (vcruntime140.dll, etc.).
; Install it silently only when absent (one UAC prompt; skipped otherwise).
Filename: "{tmp}\vc_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Microsoft Visual C++ Runtime..."; Check: VCRedistNeeded; Flags: waituntilterminated
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[Code]
function VCRedistNeeded(): Boolean;
var
  Installed: Cardinal;
begin
  // Read the native 64-bit view for the VC++ 2015-2022 x64 runtime key.
  Result := True;
  if RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64', 'Installed', Installed) then
    Result := (Installed <> 1);
end;
