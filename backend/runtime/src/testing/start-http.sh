#!/bin/sh
set -eu
# 只有非特权用户成功写入数据目录才启动健康端点，覆盖实际初始化权限。
printf 'ready\n' > /data/startup-check
exec /usr/sbin/httpd "$@"
