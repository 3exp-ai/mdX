@echo off
REM 重新打包前端 bundle。改了 public/app.js 之后跑一下,
REM 然后再 cargo tauri build / cargo build --release。
cd /d %~dp0
npx esbuild app.js --bundle --format=iife --minify --outfile=app.bundle.js
echo Bundle done: app.bundle.js
