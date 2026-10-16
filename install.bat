@echo off
rem zcode-soul one-click installer: locate ZCode, write local config, create desktop shortcut
rem Prerequisites: ZCode desktop installed. Bundled node.exe is used when present
rem (release package); otherwise Node.js 22+ from PATH is required. See README.md.
rem Batch file is ASCII-only on purpose: cmd.exe misparses UTF-8 text before chcp takes effect.
cd /d "%~dp0"
set "NODE_CMD=node"
if exist "%~dp0node.exe" set "NODE_CMD=%~dp0node.exe"
if "%NODE_CMD%"=="node" (
    where node >nul 2>nul
    if errorlevel 1 (
        echo Node.js not found. Please install Node.js 22+ first: https://nodejs.org/
        pause
        exit /b 1
    )
)
"%NODE_CMD%" tools\install.js
pause
