@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
set "UV_EXE=uv"
where uv >nul 2>nul
if errorlevel 1 (
    if exist "%USERPROFILE%\.local\bin\uv.exe" (
        set "UV_EXE=%USERPROFILE%\.local\bin\uv.exe"
    ) else (
        echo [ERROR] uv not found. Install uv or add it to PATH.
        if not "%HINDSIGHT_BAT_NO_PAUSE%"=="1" pause
        exit /b 1
    )
)

pushd "%REPO_ROOT%\hindsight-api-slim"
"%UV_EXE%" run python -m hindsight_api.engine.llama_install --all-defaults %*
set "RC=%ERRORLEVEL%"
popd

if not "%HINDSIGHT_BAT_NO_PAUSE%"=="1" pause
exit /b %RC%
