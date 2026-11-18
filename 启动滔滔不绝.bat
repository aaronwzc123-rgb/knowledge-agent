@echo off
setlocal
chcp 65001 >nul
set "TAOTAO_NODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined TAOTAO_NODE set "TAOTAO_NODE=%%N"
if not defined TAOTAO_NODE for /f "delims=" %%R in ('powershell.exe -NoProfile -Command "(Get-AppxPackage '*CodexPrimaryRuntime*' | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"') do set "TAOTAO_NODE=%%R\dependencies\node\bin\node.exe"
if not defined TAOTAO_NODE if exist "%ProgramFiles%\nodejs\node.exe" set "TAOTAO_NODE=%ProgramFiles%\nodejs\node.exe"
if not defined TAOTAO_NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "TAOTAO_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not exist "%TAOTAO_NODE%" goto missing_node
"%TAOTAO_NODE%" "%~dp0launcher.mjs" start
if errorlevel 1 goto failed
exit /b 0
:missing_node
echo 没有找到 Node.js。请安装 Node.js 22 或更新版本，或先打开一次 Codex，然后再试。
:failed
echo 滔滔不绝没能启动。请看上面的错误，以及本目录的 local-server-error.log。
pause
exit /b 1
