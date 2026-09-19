; Extra NSIS steps for the Sahne Plus installer (included by electron-builder, see package.json "build.nsis.include").
; Uninstall: remove the "run at Windows login" entry the app registers (app.setLoginItemSettings, name "SahnePlus"),
; so nothing of the program is left behind in the registry. Application data in Documents\Sahne Plus is kept on purpose.
; During an update (the old version is uninstalled with --updated) the entry is kept, so autostart survives updates.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SahnePlus"
  ${endIf}
!macroend
