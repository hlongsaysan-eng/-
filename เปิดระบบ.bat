@echo off
cd /d "%~dp0"
title Quotation System
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install it from https://nodejs.org
  pause
  exit /b 1
)
node --disable-warning=ExperimentalWarning server.js --open
pause
