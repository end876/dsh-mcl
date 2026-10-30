@echo off
chcp 65001 >nul
cd /d "%~dp0"
node bin\mcl.mjs gui
pause
