@echo off
cd /d "%~dp0"
python start_demo.py --mode live
if errorlevel 1 pause
