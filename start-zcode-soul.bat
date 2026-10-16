@echo off
rem zcode-soul 启动入口：CDP 注入 + 本地统计服务
rem 前置条件：ZCode 需完全退出后再运行本脚本
cd /d %~dp0
node launch.js
pause
