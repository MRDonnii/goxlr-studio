; GoXLR Studio – NSIS hooks for Tauri's installer.
; When GoXLR Studio is uninstalled (not when it updates itself), remove what the app set up outside
; its own folder: the built-in GoXLR engine copy and the built-in EQ engine (asks for admin once).
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\goxlr-studio.exe" --engine-uninstall'
  ${EndIf}
!macroend
