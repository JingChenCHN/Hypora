@echo off
chcp 65001
echo 正在配置淘宝镜像环境变量...
set NODE_TLS_REJECT_UNAUTHORIZED=0
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set ELECTRON_CACHE=%~dp0.electron-cache
set ELECTRON_BUILDER_CACHE=%~dp0.electron-builder-cache

echo 开始构建前端资源...
call npx vite build

echo 开始打包EXE...
call npx electron-builder --win --x64 --config.npmRebuild=false

echo 打包完成！产物在release目录
pause