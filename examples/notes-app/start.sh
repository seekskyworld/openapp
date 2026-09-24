#!/bin/sh
# 持久目录必须可写；不以 root 修正未知外部目录的权限。
set -eu
test -w /data
exec "$@"
