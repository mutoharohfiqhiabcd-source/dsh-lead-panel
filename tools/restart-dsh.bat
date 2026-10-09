@echo off
rem ==========================================================================
rem dsh-lead-panel 附带的重启脚本（Windows）
rem --------------------------------------------------------------------------
rem 用途：DSH 的 Host 进程会按 package.json 的 name 缓存插件模块，改了 Host 代码
rem 后必须换进程才生效。这个脚本会：
rem   1) 等 20 秒（留出时间让当前会话把话说完）
rem   2) 杀掉监听 3080 的旧 Host 进程
rem   3) 在 DSH 仓库目录重新拉起 `node apps/cli/lib/bin.js web`
rem   4) 全程追加日志到 %TEMP%\dsh-restart.log
rem
rem 用法：双击，或者  cmd /c D:\1231\dsh-lead-panel\tools\restart-dsh.bat
rem 之后刷新浏览器页面即可。
rem ==========================================================================
setlocal
set DSH_DIR=D:\deepseek-harness-master\deepseek-harness-master
set NODE_EXE=C:\Program Files\nodejs\node.exe
set LOG=%TEMP%\dsh-restart.log

echo. >> "%LOG%"
echo [%date% %time%] 计划 20 秒后重启 DSH >> "%LOG%"
timeout /t 20 /nobreak >nul

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3080" ^| findstr LISTENING') do (
  echo [%date% %time%] kill pid %%p >> "%LOG%"
  taskkill /PID %%p /F >> "%LOG%" 2>&1
)

timeout /t 3 /nobreak >nul

cd /d "%DSH_DIR%"
echo [%date% %time%] start: %NODE_EXE% apps\cli\lib\bin.js web >> "%LOG%"
"%NODE_EXE%" apps\cli\lib\bin.js web >> "%LOG%" 2>&1
echo [%date% %time%] dsh exited with %errorlevel% >> "%LOG%"
