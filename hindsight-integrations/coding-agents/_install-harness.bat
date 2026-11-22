@echo off
setlocal enabledelayedexpansion

set "AGENT_DIR=%~dp0"
if "%AGENT_DIR:~-1%"=="\" set "AGENT_DIR=%AGENT_DIR:~0,-1%"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found on PATH. Please install Node.js 18+ first.
    if not "%HINDSIGHT_BAT_NO_PAUSE%"=="1" pause
    exit /b 1
)

if not exist "%AGENT_DIR%\dist\installer.js" (
    echo [hindsight] Building coding-agents integration...
    pushd "%AGENT_DIR%"
    if not exist "node_modules" (
        call npm install --ignore-scripts --no-audit --no-fund
        if errorlevel 1 (
            popd
            if not "%HINDSIGHT_BAT_NO_PAUSE%"=="1" pause
            exit /b 1
        )
    )
    call npm run build
    if errorlevel 1 (
        popd
        if not "%HINDSIGHT_BAT_NO_PAUSE%"=="1" pause
        exit /b 1
    )
    popd
)

echo [hindsight] Running installer: %*
node "%AGENT_DIR%\dist\installer.js" install %*
set "RC=%ERRORLEVEL%"

if not "%HINDSIGHT_BAT_NO_PAUSE%"=="1" pause
exit /b %RC%
