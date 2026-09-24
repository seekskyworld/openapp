# OpenApp 备份与恢复运行手册

本文档是发布前的强制安全门禁。所有命令默认针对可丢弃的 staging 环境；没有明确
确认目标和恢复点时，不得在生产数据库或用户 Volume 上执行删除、初始化或覆盖操作。

## 备份范围

必须同时保存以下内容，并记录 UTC 时间、部署 fingerprint 和数据库版本：

- PostgreSQL 全量备份（`pg_dump` 或物理 base backup）。
- PostgreSQL WAL 归档；生产环境至少保留满足组织 RPO 的时间窗口。
- `postgres/data/` 所在磁盘的加密快照或异地副本。
- 配置的 `OPENAPP_RELEASE_DIR` 下的 BuildPackage、Revision manifest、构建输入和审计摘要。
- 每个 Workspace 的持久 Volume；Volume 与 Workspace ID 的映射清单。
- 当前部署 `.env` 的密钥引用清单（不把明文密钥写入备份或日志）。

## 发布前演练

1. 在 staging 生成 `pg_dump --format=custom`，并计算 SHA-256。
2. 用独立 PostgreSQL 实例创建空库，执行 `pg_restore --exit-on-error`。
3. 核对用户、Tenant、Workspace、Revision、升级批次和审计记录数量；抽查一个
   Workspace 的 `activeExecutionId`、Provider pin 和 Volume identity。
4. 启动 Portal，执行健康检查、登录、进入、刷新、停止/唤醒和退出；确认旧 URL、
   Cookie 和错误 request ID 合同不变。
5. 使用 Volume 副本写入 sentinel，依次重启 Portal、Socket Proxy 和 Runtime，
   确认 sentinel 与 Workspace 身份保持不变。
6. 保存恢复日志、数据库版本、部署 fingerprint 和结果；失败时禁止进入生产发布。

示例（仅 staging）：

```bash
set -euo pipefail
export PGPASSWORD="$STAGING_POSTGRES_PASSWORD"
pg_dump --format=custom --no-owner \
  --host "$STAGING_POSTGRES_HOST" \
  --username "$STAGING_POSTGRES_USER" \
  --dbname "$STAGING_POSTGRES_DB" \
  --file "backup-${BACKUP_TIMESTAMP}.dump"
sha256sum "backup-${BACKUP_TIMESTAMP}.dump"
createdb --host "$RESTORE_POSTGRES_HOST" --username "$RESTORE_POSTGRES_USER" \
  "openapp_restore_${BACKUP_TIMESTAMP}"
pg_restore --exit-on-error --no-owner \
  --host "$RESTORE_POSTGRES_HOST" --username "$RESTORE_POSTGRES_USER" \
  --dbname "openapp_restore_${BACKUP_TIMESTAMP}" \
  "backup-${BACKUP_TIMESTAMP}.dump"
```

## 历史制品引用验收

`containers.image_artifact_id` 的外键在新库或引用完整的数据库中会完成全表校验。
若旧实例保留了制品目录中不存在的历史 ID，迁移会保留快照并以 `NOT VALID` 添加外键：
新增、改变的引用仍受约束，旧实例可以更新运行状态，但这不代表历史制品已恢复。
迁移不会删除历史引用，也不会伪造构建或制品记录。

在恢复副本上检查未完成的校验和历史缺口：

```sql
select convalidated from pg_constraint
where conrelid = 'containers'::regclass
  and conname = 'containers_image_artifact_id_fkey';

select c.id, c.image_artifact_id from containers c
where c.image_artifact_id is not null
  and not exists (select 1 from image_artifacts a where a.id = c.image_artifact_id);
```

存在缺口时须核对备份、实际镜像和实例归属，记录未验证的升级/重建能力；不能仅凭迁移命令成功
宣称制品完整。通过可验证来源恢复目录，或通过正常业务流程完成实例替换后，再次执行迁移会在
缺口清零时自动完成外键校验。不要为了通过验收而直接清空引用。

## 时间点恢复与回滚

- 需要 PITR 时先恢复到新的 PostgreSQL 实例，再让 OpenApp 以只读/维护模式启动校验，
  不要覆盖原数据目录。
- 只有数量、身份、审计、Volume sentinel 和健康检查全部通过，才切换数据库连接。
- 保留旧 Portal 镜像、旧部署目录和旧数据库快照至少一个完整发布周期。
- 迁移失败时停止切换，保留失败副本和日志。只有经过验证的匹配旧程序与数据恢复点才能回切；恢复旧备份前必须另存新写入并制定差异处理方案。

## 日常发布保护

- 部署包必须由 `scripts/export-deployment-bundle.sh` 从 tracked source 生成。
- 发布前运行 `node scripts/check-deployment-drift.mjs <repo> <deployment>`；缺少或
  不匹配 `.openapp-source-fingerprint` 时立即停止。
- 只替换代码、模板和镜像构建输入；保留 `.env`、PostgreSQL 数据、日志、BuildPackage、
  Revision、用户 Volume。禁止 `rsync --delete` 覆盖运行目录。
- 记录发布 request ID、部署 fingerprint、数据库快照 ID 和回滚负责人。

## 验收记录模板

```text
时间（UTC）：
部署 fingerprint：
数据库快照 / WAL 范围：
恢复实例：
用户 / Tenant / Workspace / Revision / 批次 / 审计数量：
Volume sentinel 与 Workspace 身份：PASS / FAIL
Portal / Gateway / Runtime 健康：PASS / FAIL
回切验证：PASS / FAIL
request ID / 操作人：
```
