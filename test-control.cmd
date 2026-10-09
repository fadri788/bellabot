@echo off
cd /d "%~dp0"
python start_demo.py --mode bridge-simulation
if errorlevel 1 pause
