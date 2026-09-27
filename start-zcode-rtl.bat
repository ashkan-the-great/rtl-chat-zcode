@echo off
setlocal
set "HERE=%~dp0"
set "ZCODE_EXE=C:\Program Files\ZCode\ZCode.exe"
set "EXT_DIR=%HERE%extension"
set "INJECTOR=%HERE%inject-cdp.mjs"

echo [RTL Chat] Preparing launch...

tasklist /FI "IMAGENAME eq ZCode.exe" 2>nul | find /I "ZCode.exe" >nul
if %errorlevel%==0 (
  echo [RTL Chat] ZCode is running. Quitting it fully ^(including tray^)...
  powershell -NoProfile -Command "Get-Process ZCode -ErrorAction SilentlyContinue | Stop-Process -Force"
  timeout /t 3 /nobreak >nul
)

echo [RTL Chat] Starting ZCode with CDP + extension...
start "" "%ZCODE_EXE%" --remote-debugging-port=9229 --load-extension="%EXT_DIR%" --disable-extensions-except="%EXT_DIR%"

echo [RTL Chat] Waiting for CDP...
timeout /t 5 /nobreak >nul

echo [RTL Chat] Starting CDP injector daemon...
start "" /B node "%INJECTOR%"

echo [RTL Chat] Done. Look for the red badge in the chat window.
echo            Verify anytime with: node "%INJECTOR%" --verify
pause
endlocal
