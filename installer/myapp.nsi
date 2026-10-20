; MyApp per-user NSIS installer template.
; Installs the shell and app resources; Electron is supplied by the shared runtime.

!include LogicLib.nsh

!ifndef STAGING_DIR
  !error "Pass /DSTAGING_DIR=<assembled app directory> to makensis"
!endif
!ifndef OUTPUT_FILE
  !error "Pass /DOUTPUT_FILE=<installer output file> to makensis"
!endif
!ifndef APP_ID
  !define APP_ID "com.example.myapp"
!endif
!ifndef APP_NAME
  !define APP_NAME "MyApp"
!endif
!ifndef APP_VERSION
  !error "Pass /DAPP_VERSION=<application version> to makensis"
!endif
!ifndef RUNTIME_VER
  !error "Pass /DRUNTIME_VER=<exact Electron version> to makensis"
!endif

Name "${APP_NAME}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\${APP_NAME}"
RequestExecutionLevel user

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
    SetOutPath "$INSTDIR"
    File /oname=shell.exe "${STAGING_DIR}\shell.exe"
    File "${STAGING_DIR}\shell.toml"

    SetOutPath "$INSTDIR\resources"
    File "${STAGING_DIR}\resources\app.asar"
!if /FileExists "${STAGING_DIR}\resources\app.asar.unpacked"
    SetOutPath "$INSTDIR\resources\app.asar.unpacked"
    File /r "${STAGING_DIR}\resources\app.asar.unpacked\*"
!endif

    CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\shell.exe"
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; Store install metadata for the shell and uninstaller.
    WriteRegStr HKCU "Software\${APP_ID}" "InstallDir" "$INSTDIR"
    WriteRegStr HKCU "Software\${APP_ID}" "RuntimeVersion" "${RUNTIME_VER}"
SectionEnd

Section "Uninstall"
    ; Keep the installation intact if runtime unregistering fails.
    ExecWait '"$INSTDIR\shell.exe" --uninstall' $0
    ${If} $0 != 0
        MessageBox MB_ICONSTOP "Unable to unregister this installation (exit code $0). No files were removed."
        Abort
    ${EndIf}

    Delete "$INSTDIR\shell.exe"
    Delete "$INSTDIR\shell.toml"
    RMDir /r "$INSTDIR\resources"
    RMDir /r "$INSTDIR\updates"
    Delete "$INSTDIR\uninstall.exe"
    RMDir "$INSTDIR"
    Delete "$DESKTOP\${APP_NAME}.lnk"
    DeleteRegKey HKCU "Software\${APP_ID}"
SectionEnd
