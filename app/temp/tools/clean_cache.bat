@echo off
setlocal enabledelayedexpansion

REM ===============================
REM 获取当前脚本所在目录
REM ===============================
set SCRIPT_DIR=%~dp0

REM ===============================
REM 生成日志文件名（带日期时间）
REM ===============================
for /f "tokens=2 delims==." %%a in ('wmic os get localdatetime /value') do set dt=%%a
set LOGFILE=!SCRIPT_DIR!clean_cache_!dt:~0,8!_!dt:~8,6!.log

REM ===============================
REM 关键路径定义
REM ===============================
set CACHE_DIR=!SCRIPT_DIR!..\Cache_ETSShell
set ETS_EXE=!SCRIPT_DIR!..\..\Ets.exe

echo ===============================
echo   Clean Cache_ETSShell Script
echo   时间: %date% %time%
echo ===============================
echo [路径检查]
echo 脚本目录 : !SCRIPT_DIR!
echo 缓存目录 : !CACHE_DIR!
echo 程序路径 : !ETS_EXE!
echo ===============================
echo.

(
echo ===============================
echo   Clean Cache_ETSShell Script
echo   时间: %date% %time%
echo ===============================
echo [路径检查]
echo 脚本目录 : !SCRIPT_DIR!
echo 缓存目录 : !CACHE_DIR!
echo 程序路径 : !ETS_EXE!
echo ===============================

REM 1) 杀掉相关进程
echo.
echo [步骤1] 结束进程 ETSShell.exe 和 ets_mq_server.exe ...
taskkill /f /im ETSShell.exe
taskkill /f /im ets_mq_server.exe

REM 2) 删除 Cache_ETSShell 文件夹
echo.
echo [步骤2] 检查并删除缓存目录: !CACHE_DIR!
if exist "!CACHE_DIR!" (
    rmdir /s /q "!CACHE_DIR!"
    echo ? 已删除缓存目录
) else (
    echo ?? 缓存目录不存在
)

REM 3) 启动 Ets.exe
echo.
echo [步骤3] 启动程序: !ETS_EXE!
if exist "!ETS_EXE!" (
    for %%I in ("!ETS_EXE!") do set ETS_DIR=%%~dpI
    echo 使用工作目录: !ETS_DIR!
    start "" /D "!ETS_DIR!" "!ETS_EXE!"
    echo ? 已启动 Ets.exe
) else (
    echo ? 未找到 Ets.exe
)

echo.
echo ===============================
echo      操作已完成
echo ===============================
) > "!LOGFILE!"

echo ? 已完成，日志保存在: !LOGFILE!
pause
endlocal
