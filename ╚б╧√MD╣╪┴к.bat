@echo off
echo Removing .md file association...
reg delete "HKCU\Software\Classes\Hypora.md" /f > nul 2>&1
reg delete "HKCU\Software\Classes\SystemFileAssociations\.md\shell\Hypora" /f > nul 2>&1
reg delete "HKCU\Software\Classes\Applications\Hypora.exe" /f > nul 2>&1
reg delete "HKCU\Software\Classes\.md" /ve /f > nul 2>&1
echo.
echo Done. .md file association removed.
pause
