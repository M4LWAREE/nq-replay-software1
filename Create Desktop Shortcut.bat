@echo off
REM Creates a "NQ Replay Trader" shortcut on your Desktop pointing at this launcher.
setlocal
set "TARGET=%~dp0run_replay_trader.bat"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([System.IO.Path]::Combine([Environment]::GetFolderPath('Desktop'),'NQ Replay Trader.lnk')); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%SystemRoot%\System32\shell32.dll,137'; $s.Description='Launch NQ Replay Trader (localhost:5056)'; $s.Save()"
echo Desktop shortcut created: "NQ Replay Trader"
pause
