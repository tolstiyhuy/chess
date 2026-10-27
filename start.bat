@echo off
cd /d "%~dp0"
title Шахматы

where node >nul 2>nul
if errorlevel 1 goto trypython
node server.js
goto end

:trypython
where python >nul 2>nul
if errorlevel 1 goto nothing
echo Node.js не найден, запускаю через Python...
echo Режим "Локальная сеть" работает только с Node.js.
python -m http.server 8000
goto end

:nothing
echo Не найден ни Node.js, ни Python.
echo Откройте файл index.html в браузере: офлайн-игра и бот работают и так.
pause

:end
