; Added to electron-builder's maintained NSIS installer, never a replacement
; installer. The adapter composes a developer's customUnInit as
; minitronUserUnInit before including this file.
!ifndef MINITRON_INSTALLER_NSH
!define MINITRON_INSTALLER_NSH

Var /GLOBAL minitronLifecycleResult
Var /GLOBAL minitronLifecycleOutput
Var /GLOBAL minitronProcessRecord

!macro minitronStopInstallation
  ${If} ${FileExists} "$INSTDIR\minitron.toml"
    InitPluginsDir
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\${PRODUCT_FILENAME}.exe" "$PLUGINSDIR\minitron-lifecycle.exe"
    ${If} ${Errors}
      SetErrorLevel 2
      Abort "Unable to prepare the application lifecycle helper."
    ${EndIf}
    nsExec::ExecToStack '"$PLUGINSDIR\minitron-lifecycle.exe" --app-dir "$INSTDIR" --stop'
    Pop $minitronLifecycleResult
    Pop $minitronLifecycleOutput
    ${If} $minitronLifecycleResult != "0"
      DetailPrint "$minitronLifecycleOutput"
      SetErrorLevel 2
      Abort "Unable to stop this application safely."
    ${EndIf}
  ${EndIf}
!macroend

; The default check stops all executables with the same filename. Scope the
; check to this installation instead, including any orphaned Electron child.
!macro customCheckAppRunning
  ; Mutable state may live in the user's runtime cache, including when the
  ; installation is under Program Files. Ask the installed launcher so this
  ; stays compatible with both legacy and current state layouts.
  StrCpy $minitronProcessRecord "$INSTDIR\updates\process.json"
  ${If} ${FileExists} "$INSTDIR\minitron.toml"
    nsExec::ExecToStack '"$INSTDIR\${PRODUCT_FILENAME}.exe" --app-dir "$INSTDIR" --state-dir'
    Pop $minitronLifecycleResult
    Pop $minitronLifecycleOutput
    ${If} $minitronLifecycleResult == "0"
      ${TrimNewLines} $minitronLifecycleOutput $minitronLifecycleOutput
      StrCpy $minitronProcessRecord "$minitronLifecycleOutput\process.json"
    ${EndIf}
  ${EndIf}
  ${If} ${FileExists} "$minitronProcessRecord"
    ${IfNot} ${Silent}
      ${IfNot} ${isUpdated}
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
  !insertmacro minitronStopInstallation
  !ifmacrodef minitronUserCheckAppRunning
    !insertmacro minitronUserCheckAppRunning
  !endif
!macroend

!macro customUnInit
  ; The copied helper remains executable while installed files are removed.
  !insertmacro minitronStopInstallation
  ${If} ${FileExists} "$INSTDIR\minitron.toml"
    ; An upgrade keeps its runtime reference until the new application starts.
    ; A real uninstall unregisters before any configuration files are removed.
    ${IfNot} ${isUpdated}
      nsExec::ExecToStack '"$PLUGINSDIR\minitron-lifecycle.exe" --app-dir "$INSTDIR" --uninstall'
      Pop $minitronLifecycleResult
      Pop $minitronLifecycleOutput
      ${If} $minitronLifecycleResult != "0"
        DetailPrint "$minitronLifecycleOutput"
        SetErrorLevel 2
        Abort "Unable to unregister this application safely."
      ${EndIf}
    ${EndIf}
  ${EndIf}
  !ifmacrodef minitronUserUnInit
    !insertmacro minitronUserUnInit
  !endif
!macroend

!endif
