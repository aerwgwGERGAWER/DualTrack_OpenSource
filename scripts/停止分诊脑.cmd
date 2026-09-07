@echo off
chcp 65001 >nul
title 停止分诊脑 (小模型管家)
setlocal
set "DIR=%~dp0"
echo [分诊脑] 写入停止标记并关闭管家...
echo stop> "%DIR%.butler.stop"
timeout /t 2 /nobreak >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'butler-supervisor' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
del /q "%DIR%.butler.stop" 2>nul
del /q "%DIR%.butler.pid" 2>nul
echo [分诊脑] 已停止。
timeout /t 2 /nobreak >nul 2>nul
