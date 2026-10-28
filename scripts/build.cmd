@echo off
rem Perchly 一键打包（Windows 双击版）—— 实际逻辑在 build.sh，需要 Git Bash
where bash >nul 2>nul || (echo [失败] 未找到 bash，请安装 Git for Windows & exit /b 1)
bash "%~dp0build.sh" %*
