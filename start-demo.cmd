@echo off
cd /d "%~dp0"
python start_demo.py
if errorlevel 1 pause
