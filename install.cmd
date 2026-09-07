@echo off
chcp 65001 >nul
title DualTrack Memory - 一键安装
echo ==========================================
echo   DualTrack Memory - 一键安装 (v1.3)
echo ==========================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] 未找到 Node.js。请先安装 Node.js ^>= 18: https://nodejs.org
  pause
  exit /b 1
)
echo [OK] 检测到 Node.js，开始安装与自检...
echo.

node scripts\install.mjs

echo.
echo ==========================================
echo   安装完成。
echo   后续接入/排错: 把本仓库连同 docs\AI_INSTALL.md 交给你的 AI 助手。
echo ==========================================
pause
