#!/bin/sh
# 由镜像用户直接写入工作区，权限错误应在首次启动时显式失败。
set -eu
test -w /data
exec "$@"
