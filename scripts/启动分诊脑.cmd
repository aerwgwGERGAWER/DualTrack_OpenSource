@echo off
chcp 65001 >nul
title 启动分诊脑
setlocal
set "DIR=%~dp0"
set "CFG=%DIR%memory.config.json"
set "TRIAGEFILE=%DIR%.triage.tmp"
set "RESULT="
node "%DIR%butler-supervisor.mjs" --check "%CFG%" > "%TRIAGEFILE%" 2>nul
set /p TRIAGE=<"%TRIAGEFILE%"
del /q "%TRIAGEFILE%" 2>nul
if "%TRIAGE%"=="" set TRIAGE=hash
if /i "%TRIAGE%"=="hash" goto HASH
if /i not "%TRIAGE%"=="qwen" goto NOPE
echo [分诊脑] triage_brain=qwen, 正在后台启动管家(隐藏窗口)...
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process -FilePath 'node.exe' -ArgumentList '%DIR%butler-supervisor.mjs' -WorkingDirectory '%DIR%' -WindowStyle Hidden"
exit /b 0

:HASH
echo [分诊脑] 当前为哈希模式, 无需启动。请先在 memory.config.json 设 dual_track.router.triage_brain=qwen, 并安装 Ollama 拉取模型。
pause
exit /b 0

:NOPE
echo [分诊脑] 当前 triage_brain=%TRIAGE%, 管家仅支持 qwen, 无需启动。
pause
exit /b 0
