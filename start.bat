@echo off
chcp 65001 >nul
title Шахматы
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8000'"
  node server.js
  goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo Node.js не найден, запускаю через Python...
  echo Внимание: режим "Локальная сеть" работает только с Node.js.
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:8000'"
  python -m http.server 8000
  goto :end
)

echo Не найден ни Node.js, ни Python.
echo Просто откройте index.html в браузере — локальная игра и бот работают.
pause

:end
