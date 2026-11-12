; Keep user databases, knowledge, model configuration and native-tool data on uninstall.
; electron-builder's per-user NSIS install provides Add/Remove Programs and shortcuts.
!include "${BUILD_RESOURCES_DIR}\icon-name.nsh"
!macro customInstall
  ; A content-based icon path also refreshes builds sharing the same product version.
  ; Refresh only existing shortcuts, preserving the user's shortcut choices.
  ${if} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\resources\${LOOPMARSHAL_SHORTCUT_ICON}" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${endIf}
  ${if} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\resources\${LOOPMARSHAL_SHORTCUT_ICON}" 0 "" "" "${APP_DESCRIPTION}"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}
  CreateShortCut "$SMPROGRAMS\LoopMarshal 命令行.lnk" "$SYSDIR\cmd.exe" '/K ""$INSTDIR\resources\loopmarshal\bin\loopmarshal.cmd" --help"' "$INSTDIR\resources\${LOOPMARSHAL_SHORTCUT_ICON}" 0
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\LoopMarshal 命令行.lnk"
!macroend
