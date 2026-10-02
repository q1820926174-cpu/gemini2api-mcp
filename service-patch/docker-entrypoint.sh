#!/bin/sh
# 入口脚本（VULN 非 root 加固的升级安全版）：
# 以 root 启动时，先把 bind 挂载的可写卷（/app/data、/app/api）归属给 appuser，
# 再降权（gosu）到非 root 的 appuser 运行真正的服务进程。
#
# 为什么需要它：镜像内进程以非 root 运行，但 ./data 这类 bind 挂载的属主由宿主决定
# （历史部署里常是旧 root 容器或某个宿主 uid 创建的）。若不修复属主，非 root 进程会
# PermissionError 写不了 cookies/logs/usage-stats 等而启动崩溃。有了本脚本，
# `docker compose pull && docker compose up -d` 对历史部署也能无缝升级，无需手动 chown。
#
# 若容器被显式指定以非 root 启动（compose 设了 user:），则无法 chown，直接运行，
# 写权限由使用者自行保证（与一般非 root 容器行为一致）。
set -e

if [ "$(id -u)" = "0" ]; then
    chown -R appuser:appuser /app/data /app/api 2>/dev/null || true
    exec gosu appuser "$@"
fi

exec "$@"
