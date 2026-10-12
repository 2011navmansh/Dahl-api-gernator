@echo off
title API Extractor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js install nahi hai. Pehle Node.js install karo.
  pause
  exit /b 1
)

if not exist "node_modules\puppeteer" (
  echo Dependencies install ho rahi hain, ek minute ruko...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install fail ho gaya.
    pause
    exit /b 1
  )
)

echo Starting automation...
echo Browser taskbar me minimized khulega - taskbar pe click karke dekh sakte ho.
echo.

node extractor.js

echo.
echo Run khatam. Output apis.txt me hai.
pause
