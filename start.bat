@echo off
setlocal
cd /d "%~dp0"
set HOST=0.0.0.0
set PYTHON_CMD=python
where python >nul 2>nul
if errorlevel 1 set PYTHON_CMD=py -3

if "%PORT%"=="" set PORT=8000

:find_port
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul
if errorlevel 1 goto start_server
echo Port %PORT% is already in use, trying next port...
set /a PORT=%PORT%+1
goto find_port

:start_server
start "" "http://127.0.0.1:%PORT%"
%PYTHON_CMD% app.py %PORT% %HOST%
pause
