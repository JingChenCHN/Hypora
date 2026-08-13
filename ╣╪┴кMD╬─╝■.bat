@echo off
rem Locate Hypora.exe: same folder as this script, or (if in project root) release\Hypora\
set "EXE=%~dp0Hypora.exe"
if not exist "%EXE%" set "EXE=%~dp0release\Hypora\Hypora.exe"
if not exist "%EXE%" (
  echo [Error] Hypora.exe not found.
  echo Place this script next to Hypora.exe, or in the project root folder.
  pause
  exit /b 1
)
echo Associating .md files with Hypora...
reg add "HKCU\Software\Classes\.md" /ve /d "Hypora.md" /f > nul
reg add "HKCU\Software\Classes\Hypora.md" /ve /d "Hypora" /f > nul
reg add "HKCU\Software\Classes\Hypora.md\DefaultIcon" /ve /d "%EXE%,0" /f > nul
reg add "HKCU\Software\Classes\Hypora.md\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f > nul
reg add "HKCU\Software\Classes\SystemFileAssociations\.md\shell\Hypora" /ve /d "Open with Hypora" /f > nul
reg add "HKCU\Software\Classes\SystemFileAssociations\.md\shell\Hypora\command" /ve /d "\"%EXE%\" \"%%1\"" /f > nul
reg add "HKCU\Software\Classes\Applications\Hypora.exe" /ve /d "Hypora" /f > nul
reg add "HKCU\Software\Classes\Applications\Hypora.exe" /v FriendlyAppName /d "Hypora" /f > nul
reg add "HKCU\Software\Classes\Applications\Hypora.exe\shell\open\command" /ve /d "\"%EXE%\" \"%%1\"" /f > nul
echo.
echo Done. .md files are now associated with Hypora.
echo   - Double-click a .md file to open it with Hypora
echo   - Right-click a .md file for "Open with Hypora"
echo If it does not take effect immediately, restart Explorer or log off/on.
pause
