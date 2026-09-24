# 管理台运维能力

管理员工作台现在把配置、监测和长操作分成三个独立的生效层次。

## 配置生效

- `immediate`：自动创建、自动启动、闲置停止、活动检测、容量限制和转发策略立即生效。
- `new_instances`：默认 App、当前 Revision、环境变量和启动配置只影响之后创建的实例；已有实例仍使用其 Revision 和镜像快照。
- `rebuild`：CPU、内存和 PID 限制需要显式重建应用到已有实例；重建已绑定 App 的实例仍保留原版本/image 快照。
- `restart`：运行时、数据库、身份 Provider 地址、静态目录、发布目录和 Cookie 安全配置需要重启 Portal。

策略和转发更新使用配置 revision。浏览器会通过 `If-Match` 发送已读 revision；版本冲突时服务端返回 `409 config_revision_conflict`，管理员需要刷新后重新确认差异。

```text
GET  /api/admin/config-revisions/instance-policy?limit=50
POST /api/admin/config-revisions/instance-policy/:revision/rollback
GET  /api/admin/config-revisions/forwarding?limit=50
POST /api/admin/config-revisions/forwarding/:revision/rollback
```

历史接口只返回策略摘要；环境变量和启动配置文件不会返回给浏览器。回滚在服务端读取原始快照并追加一个新 revision。

## 监测接口

所有接口都要求管理员会话或 CLI 管理凭证：

```text
GET  /api/admin/dashboard
GET  /api/admin/monitor/instances
GET  /api/admin/monitor/instances/:id/metrics
GET  /api/admin/monitor/health
GET  /api/admin/audit
GET  /api/admin/config
POST /api/admin/runtime/check
POST /api/admin/forwarding/test
GET  /api/admin/events       # SSE，10 秒快照
```

同样的监测、审计、后台操作和配置历史可通过 `openappctl` 查询或执行：
`monitor instances|metrics`、`health`、`audit`、`operations list|get|cancel|retry`、
`config-revisions <kind> list|rollback`。CLI 修改策略前会先读取 revision 并发送
`If-Match`，不会静默覆盖其他管理员的更新。

运行实例默认每 20 秒采样一次 Docker stats，快照写入 `runtime_samples`，健康检查写入 `health_checks`。采样有并发上限，数据库保留最近窗口；GPU 或其他指标不可用时返回 `null`，资源汇总会标记不完整，不会伪造为零。闲置扫描、采样和上传临时文件清理由 PostgreSQL maintenance lease 串行化，多 Portal 进程不会重复执行；同一 Portal 内也有 single-flight，详情采样不会和后台采样重叠。启动时只回收超过 24 小时且匹配固定前缀的残留上传目录/激活临时文件。

概览中的用户、实例和实例策略属于核心持久化数据；这些读取失败时接口返回 `503 persistence_unavailable`，不会返回伪造的零值。浏览器会保留上一次有效快照并显示失败来源。指标历史读取失败时才回退到当前进程的短期缓存，并标记 `persistenceDegraded`。

## 后台操作

镜像 pull/load、App image update、兼容版本上传、维护扫描、批量启停/重建会返回 `202` 和 `operationId`：

```text
GET  /api/admin/operations
GET  /api/admin/operations/:id
POST /api/admin/operations/:id/cancel
POST /api/admin/operations/:id/retry
```

任务状态为 `queued`、`running`、`succeeded`、`failed`、`cancelled`。运行中的任务会持续写入心跳；Portal 重启后，只有心跳超过 10 分钟的 queued/running 任务才会标记为 `failed/portal_restarted`，不会误杀另一个仍在执行的 Portal。恢复使用数据库原子条件更新，旧执行器不能把已恢复的任务写回成功；维护循环会周期性处理过期任务。

需要安全重放的提交可以携带 `Idempotency-Key`。服务端按“管理员 + 幂等键”原子创建或读取任务，并同时校验操作类型、资源和请求指纹：批量实例操作绑定动作及排序后的实例 ID，镜像导入绑定镜像引用及归档 SHA-256，App image update 绑定 expectedRevision 与 replacement package ID。同一个键提交不同内容会返回 `409 idempotency_key_conflict`，不会静默复用旧任务。请求指纹只保存摘要，不保存上传内容或身份凭证。

只有标记为可协作取消的任务会显示取消入口。运行中的取消先进入 `cancelling`，本地或其他 Portal 的执行器会在心跳/进度检查时观察到取消标记，待任务观察到 `AbortSignal` 后才变为 `cancelled`；批量任务会保留已完成子项结果。镜像导入与已经越过提交点的 image update 不会伪装成已取消。Portal 重启后执行器闭包不存在，遗留任务的 `retryable` 会清零，必须重新发起操作。

重试通过按原任务 ID 获取的分布式 maintenance lease 串行化，并先占用原任务的 retry 权；同一失败任务不会被两个 Portal 重复启动。重试失败后应在最新的子任务记录上继续重试。PostgreSQL 会在维护恢复周期删除超过 30 天的终态任务，幂等键在保留期内有效；内存模式同时限制任务和重试闭包数量。

管理台对正在运行的操作按秒刷新，离开运行时页面会取消对应请求和等待定时器；单次等待有明确截止时间。任务本身仍在服务端继续执行，可在“操作与审计”页面重新查看，不依赖浏览器页面存活。

App 的每次镜像更新都会形成内部 Revision；管理员不需要维护 App SemVer。候选
Revision 构建失败时当前 Revision 不变。回滚通过把仍保留的旧 Revision 重新设为
当前完成，已有运行实例不会被隐式重启或升级。

## 任务批次

镜像升级、原镜像重建和应用资源策略重建使用独立的持久化任务批次，不占用上面的通用后台操作记录。提交后
Portal 固化每个实例的目标 Revision、ImageArtifact、不可变镜像引用和启动配置，立即
返回 `202`；浏览器是否停留在页面上不影响后台继续执行。之后又绑定的新 Revision
不会改变已创建批次的目标。创建时记录的来源和运行意图只是初始快照；Worker 在每次
真正执行前会在实例级维护租约内重新读取当前实例，刷新回滚来源和最新的
`running/stopped` 意图。

批次管理接口均为 admin-only。普通用户不能列出、搜索或操作其他任务批次；当本人实例处于
`failed` 时，实例启动/进入接口提供一个仅限所有者的恢复例外，且只返回公共任务状态：

```text
POST /api/admin/upgrade-rollouts
     JSON: { "instanceIds": ["instance-a", "instance-b"], "taskKind": "image_upgrade" }
GET  /api/admin/upgrade-rollouts?limit=100
GET  /api/admin/upgrade-rollouts/:rolloutId
GET  /api/admin/upgrade-rollouts/:rolloutId/items/:instanceId
POST /api/admin/upgrade-rollouts/:rolloutId/items/:instanceId/force
POST /api/admin/upgrade-rollouts/:rolloutId/items/:instanceId/continue
POST /api/admin/upgrade-rollouts/:rolloutId/items/:instanceId/revalidate
POST /api/admin/upgrade-rollouts/:rolloutId/items/:instanceId/cancel

POST /api/containers/:instanceId/start
POST /api/containers/:instanceId/enter
GET  /api/containers/:instanceId/recovery
```

用户恢复接口按实例当前不可变镜像和提交时的资源策略创建或复用 `instance_recovery`
批次并立即返回 `202`。用户可通过本人实例的恢复状态接口轮询最小化的批次/单项状态；
重建、健康验证、最多三次自动重试和 `needs_attention` 结算由后台 Worker 执行。
用户响应不包含目标镜像、启动配置或诊断日志；管理员可在批次详情中
查看退出码、OOM、健康状态、资源限制和已脱敏日志，并手动再次恢复。

`taskKind` 可取 `image_upgrade`、`rebuild_same_image`、`apply_resource_policy` 或内部的
`instance_recovery`。镜像升级固定 App 当前镜像；原镜像重建固定每个实例当前镜像；
资源策略重建固定建批时保存的资源策略快照；实例恢复固定当前实例镜像和资源策略快照。
一次提交接受 1 到 10,000 个去重后的实例 ID。可在请求头携带 `Idempotency-Key`；同一
管理员用同一键和相同实例集合重放会得到原批次，用同一键提交不同集合则返回
`409 idempotency_key_conflict`。旧的 `POST /api/admin/containers/actions` 在
`action=rebuild` 时也会转入同一任务批次流程，未指定任务类型的旧请求按
`useLatestVersion` 兼容映射。

同一个实例可以连续出现在多个 rollout 中。建批只记录不可变目标并立即入队，不会因为
上一批处于“已部署，待首次启动验证”而返回冲突。实际 Docker 替换仍由
`upgrade-instance:<instance-id>` 维护租约串行执行；新批次只会排队，不能并发创建第二套
candidate。后一个版本到达安全部署点时，较早的待验证单项会原子地变为
`superseded`，前一批因此可以完成，但该结果只表示“已替代（未验证）”，不计入健康成功。
镜像升级、原镜像重建和资源策略重建真正执行时，都会把当前已部署但未验证的候选接受为
新基线，删除更早的回滚代次，再从该基线创建新候选；新候选失败时只回滚到这个最新基线。

列表返回批次汇总，详情返回每个实例的来源状态、期望状态、目标 Revision/资源策略、当前状态、
阻塞原因、尝试次数和下次检查时间。服务端不会向浏览器返回幂等键、请求指纹、
launch profile、目标镜像引用、ImageArtifact ID 或运行时合同。管理台每 10 秒刷新
批次列表；展开一个批次后会同时刷新该批次的实例明细。

批次状态含义如下：

| 状态 | 含义 |
| --- | --- |
| `running` | 仍有实例排队、评估、等待空闲、重建或校验。 |
| `succeeded` | 所有实例都已进入终态且没有失败；其中 `superseded` 表示未验证版本已被后续部署替代，不等同于健康验证成功。 |
| `partial_failed` | 所有实例已进入终态，但至少一个实例为 `failed`。 |
| `cancelled` | 所有实例已进入终态，且至少一个实例被取消，没有需处理项。 |
| `needs_attention` | 至少一个实例遇到永久错误或事务证据矛盾，需要管理员处理。 |

实例项通常按以下状态前进：

```text
queued -> assessing -> waiting_for_idle -> assessing
                    \-> draining -> rebuilding -> verifying -> succeeded (running)
                                                     \-> awaiting_first_start
                    \-> superseded (when a newer deployment reaches a safe checkpoint)
                    \-> queued (retry_scheduled)
                    \-> needs_attention / cancelled
```

`waiting_for_idle` 不是失败，也不消耗 `attemptCount` 失败预算；没有历史执行失败时，
后台每 30 秒重新检查一次。只有重建、校验或首次健康启动回滚等实际失败才增加预算，
后续重试按失败次数指数退避且最长 5 分钟。默认 120 次实际失败后进入 `failed`；实例
不存在、目标未就绪或事务证据矛盾等永久错误会直接进入 `needs_attention`。人工
`continue` 或 `force` 会把预算重置为零。常见阻塞原因为
`active_stream`、`active_websocket`、`activity_observation`、`active_connection`、
`instance_creating`、`retry_scheduled` 和
`candidate_awaiting_first_healthy_start`。`awaiting_first_start` 是软等待：停止实例已换到
目标候选，且在没有后续重建任务时仍保留旧代次作为首次启动回滚点。后续任一重建任务执行时，
当前候选会直接成为新基线，更早代次被删除；后续任务到达安全部署点时，旧项会变成
`superseded`。只有首次启动通过健康探针才计为健康成功。空闲等待和首次启动
等待都不会仅因经过很久而耗尽失败预算。批次只有在全部实例进入终态后才结束；已经完成的
实例不会因其他实例仍在等待而回滚。

对运行实例，Portal 同时检查代理连接租约和 Docker 累计指标。HTTP/SSE 仍在处理、
WebSocket 最近仍有数据、网络收发计数仍变化，或 CPU 超过阈值时不会停止容器。只有
跨越完整 60 秒静默窗口的两次样本满足低负载，最终门禁又确认没有活动连接后，才会
进入 drain。drain 期间新代理请求和普通启动、停止、删除、重建会返回冲突，避免与
升级交叉执行；重建结束后门禁自动清除。

等待期间的人工生命周期操作不会被建批时的状态覆盖。例如，运行实例在等待空闲期间
被管理员停止，Worker 下次取得实例级租约后会把期望状态更新为 `stopped`，以当前
Revision/ImageArtifact/镜像引用刷新回滚来源，并在不启动候选的情况下升级；反向启动
则会保留最新的 `running` 意图。这个动态来源和运行意图不会改变批次固定的升级目标。

### 五个实例同时升级

假设一个批次包含五个不同状态的实例，当前实现会分别处理，不会让第一个繁忙实例
卡住整批或管理页面：

| 实例状态 | 后台行为 | 对现有服务的影响 |
| --- | --- | --- |
| `running` 且繁忙 | 转为 `waiting_for_idle`，记录具体连接或活动阻塞原因，并按退避时间重新评估；达到安全窗口后才重建。 | 原容器继续服务，不会因为另四个实例先升级而被强制停止。 |
| `running` 且空闲 | 首次样本进入 `activity_observation`；静默窗口确认后取得 drain，重建并启动候选，健康探针成功后完成。 | 仅在已确认空闲后的 Docker 替换阶段短暂不可用，最终保持 `running`。 |
| `stopped` | 跳过运行活动评估，用同一 Volume 创建停止的目标候选；单项进入 `awaiting_first_start`。没有后续重建任务时，首次启动探针失败会恢复旧代次；有后续重建任务时，当前候选成为下一批基线。 | 不会为了任务而启动实例；连续执行镜像升级、原镜像重建或资源策略重建时，只保留最新已部署版本作为回滚基线，不继续保留更早代次。 |
| `creating` | 转为 `waiting_for_idle/instance_creating`，不占住 Worker；创建结束后按新的实际状态重新评估。 | 不打断正在进行的创建。 |
| `failed` | 作为非运行实例尝试重建或补建，最新运行意图为 `stopped`；执行失败按退避重试，候选成功创建后仍等待首次健康启动。 | 永久错误进入 `needs_attention`，实际失败达到预算进入 `failed`；停止候选不会被升级流程擅自启动。 |

因此中间快照可能显示 5 个请求中，空闲实例已经完成，繁忙、创建中和等待首次启动的
停止实例仍在等待，失败实例正在重试。rollout 的 `completed/requested`、`succeeded`、
`failed`、`waiting` 持续反映这一拆分；只有最后一个实例成功、取消、失败或需人工处理
后，批次才进入终态。

### 恢复与人工动作

Portal 启动和每 30 秒维护周期都会唤醒 rollout Worker。批次及实例项保存在 PostgreSQL
时，Portal 重启不会丢失；处于 `assessing`、`draining`，或没有事务 ID 的
`rebuilding/verifying`，在 10 分钟没有更新后会回到 `queued`，阻塞原因为
`portal_restarted`。`rebuilding/verifying` 单项只要已有事务 ID，无论目标状态是
`running` 还是 `stopped`，都会保留该 ID，把状态改为 `awaiting_first_start` 并记录
`candidate_recovery_pending` blocker：Worker 必须先调用只读的
`inspectRebuildTransaction` 对账既有 Runtime 事务，再决定完成、等待、重试或转人工
处理，绝不会直接签发新 attempt 并重复 rebuild。活动租约的心跳超时会自动忽略，drain
也有两小时过期保护，因此异常退出不会留下永久门禁。全局 Worker 租约、逐实例维护租约
和 revision CAS 共同避免多个 Portal 重复升级同一实例或由旧执行器覆盖恢复后的状态。

PostgreSQL 维护租约连接发生错误或断开时会中止该租约的 `AbortSignal`。Portal 将这个
信号贯穿实例同步、启动、停止、重建、删除以及 Runtime 事务检查，并传给正在执行的
Docker CLI；租约丢失会终止当前命令并阻止后续 Docker 副作用和控制面提交。下次 Worker
取得租约后仍按上述事务证据恢复，而不是假定上一次操作成功或从头重复执行。

人工动作只对 `queued`、`waiting_for_idle`、`failed`、`needs_attention` 中适用的实例
开放；对正在 drain、重建、校验或已经成功的实例操作会返回 `409`：

- `continue`：清除错误与强制标记、重置重试预算，立即重新排队并继续等待安全窗口。
- `force`：重置重试预算并跳过活动观测与活跃连接检查；取得原子 drain 门禁后会中止
  现有 HTTP/SSE/WebSocket，再立即执行重建，因此只应用于管理员明确接受连接中断的场景。
- `revalidate`：仅适用于 `image_upgrade` 的
  `needs_attention / candidate_first_start_proof_missing`。它把项目恢复到
  `awaiting_first_start`，由 Worker 重新检查当前容器的目标镜像、运行状态和 Runtime
  事务证据；不会创建候选、停止容器或删除 Volume。目标仍匹配且已停止时继续等待首次
  健康启动，已运行且健康时完成；目标不匹配或证据矛盾时仍回到 `needs_attention`。
- `cancel`：只取消该实例项，保留该批次其他实例的结果和执行。

`candidate_first_start_proof_missing` 表示旧 Portal 在“已部署候选、等待首次启动”期间
丢失了 Runtime 事务证明，不等同于候选已回滚或容器损坏。Worker 启动阶段会通过专项查询
扫描历史镜像升级项目并自动重新核验；租约暂不可用时会在下一轮重试。管理端的 `revalidate`
是同一逻辑的人工触发入口。
原镜像重建和资源策略批次仍要求严格的事务证明，不会因为镜像和停止状态相同而自动放行。
如果当前实例与该历史项目的目标身份不一致，专项核验不会修改项目，它仍保持 `needs_attention`；
只有一个更晚的部署真正提交到 `awaiting_first_start` 或 `succeeded` 检查点后，旧镜像升级项目
才会原子地变为 `superseded`。后者证明最新版本已经成为部署基线，不是用状态覆盖目标漂移。

`awaiting_first_start` 已经持有停止的目标候选和旧代次回滚点，不属于上述可操作状态；
管理端只展示“等待首次健康启动”且不显示单项按钮。管理员通过实例的普通启动动作触发
健康探针，Worker 随后的事务对账负责把单项收敛为成功、重试或需处理。

Docker 重建先创建 `-rebuild-next` 候选，再停止旧容器、把旧容器改名为
`-rebuild-previous`，最后把候选切为正式名称。运行目标只有在 `/api/health` 成功后
才删除旧容器；失败时删除候选并恢复旧容器。该事务复用原 Volume，不删除实例数据。
每次重建使用 Worker 的 `attemptId` 作为 Runtime 事务 ID，并写入候选与 predecessor
关系标签。停止目标进入 `awaiting_first_start` 后，Worker 通过只读事务检查区分：
`pending`（仍保留可回滚候选）、`committed`（健康启动已提交）、`not_found`（证据已
消失，必须结合来源/目标快照判定）和 `inconsistent`（标签或代次关系矛盾）。`committed`
即使后来又被用户停止仍可完成；`not_found` 绝不单独当作成功，目标已回退时会重新尝试，
无法证明时转为人工处理。任一后续重建任务都会显式签发“接受延迟候选”策略；Runtime 只在
canonical 候选、`-rebuild-previous`、owner、事务 ID 和 predecessor ID 构成唯一合法关系，
且候选从未请求启动时删除 previous。存在 `-rebuild-next`、rollback tombstone 或标签
矛盾时拒绝接受。删除 previous 后即使 Portal 中断，重试也从 canonical 最新基线继续，
不会恢复更早版本。Worker 还会同步 Runtime 代次并校验目标 Revision、
ImageArtifact、镜像引用及要求的运行状态，不能只凭镜像标签判断成功。

非 `succeeded/cancelled` 的单项会同时保护最新回滚来源和固定升级目标，包括它们的
Revision、ImageArtifact 与不可变镜像引用；`failed` 和 `needs_attention` 仍可人工重试，
所以也继续持有这些引用。资源清理的 preview、prune 和数据库原子删除都会重新检查这
两侧引用，不能在批次等待、执行或待处理时归档 Revision、删除 Artifact 或清除关联包。
单项成功或取消后才释放 rollout 自身的保护；实例、当前 Revision 等其他正常引用仍然
独立生效。

## App、镜像与策略

管理台将 App、BuildPackage、BuildStrategy、App Revision 和镜像生命周期分开：
App 是稳定的业务身份；BuildPackage 是可复用的单槽位上传包；BuildStrategy 定义
包槽位与运行时合同；App Revision 是一次不可变包组合；ImageBuild 是一次构建执行，
成功并通过烟测后产生不可变 ImageArtifact 候选。构建记录冻结策略 revision 和包
快照，后续修改策略或再次上传同名文件都不会改变已有 Revision 或实例。

外部 Adapter 声明策略 revision、必需槽位与允许扩展名。Core 按已注册合同校验，不内置具体业务策略。上传文件
保存在 `OPENAPP_RELEASE_DIR/build-packages/<package-id>/`，数据库只保存相对
`storageKey`；Portal 重启或部署目录迁移后仍可通过包 ID 复用。

```text
GET  /api/admin/build-strategies
GET  /api/admin/build-packages?strategyId=sample-build&key=backend
POST /api/admin/build-packages?strategyId=sample-build&key=backend
DELETE /api/admin/build-packages/:packageId
POST /api/admin/apps/:appId/image-updates
     # JSON: strategyId, expectedRevision, replacementPackageIds
POST /api/admin/apps/:appId/image-updates/:revisionId/bind
     # JSON: expectedRevision
GET  /api/admin/image-builds
POST /api/admin/image-builds                 # JSON: strategyId, packageIds
GET  /api/admin/image-builds/:id
GET  /api/admin/image-artifacts
DELETE /api/admin/image-artifacts/:artifactId
GET  /api/admin/resource-cleanup?keepPrevious=1
POST /api/admin/resource-cleanup              # JSON: keepPrevious
```

日常更新顺序固定为：上传需要替换的单包，提交 image update，等待构建和运行时
烟测完成，再显式 bind。image update 从当前 Revision 继承未提交的槽位，因此只换
Backend 或只换 Web 都不需要重复上传另一包。构建失败只留下失败记录，不会改变
当前 Revision。bind 必须提交管理员读取时的 `expectedRevision`；若期间已有其他
管理员完成绑定，返回 `409 app_revision_conflict`，刷新后重新确认，不覆盖对方结果。

```bash
openappctl --identity admin build-packages upload sample-build backend ./backend.tgz
openappctl --identity admin apps image update <app-id> <expected-revision> backend=<package-id>
openappctl --identity admin operations wait <operation-id>
openappctl --identity admin apps image bind <app-id> <candidate-revision-id> <expected-revision>
openappctl --identity admin containers upgrade <container-id>
openappctl --identity admin cleanup preview
openappctl --identity admin cleanup run
```

新建实例使用当前 Revision。已有实例保留自己的 Revision、ImageArtifact 和
Volume；`containers upgrade` 或管理员 rebuild 的 `useLatestVersion=true` 才会升级
到当前镜像。回滚同样是显式 bind 旧候选，再按需升级实例。

`cleanup preview [keep-previous]` 只提供决策信息，不能作为稍后删除的授权；
`cleanup run [keep-previous]` 才执行相同策略。`keep-previous` 默认为 1，允许 1 到 20，
因此存在旧候选时，每个 App 至少保留最近一个可回滚 Revision。任何仍被 Container
引用的 Revision 都会跳过，不区分实例正在运行还是已经停止；非成功/非取消 rollout
引用的来源和目标 Revision 也会跳过。超过保留范围且无实例或 rollout 引用的旧
Revision 会归档，并保留包 SHA-256、大小、构建状态等审计摘要，同时清除对实体
BuildPackage 和 ImageArtifact 的引用。随后只删除不再被其他 Revision、ImageBuild、
Container 或受保护 rollout 来源/目标引用的包记录/文件、Artifact 和 Runtime 镜像。

手动删除 BuildPackage 时服务端会原子检查 App Revision 与 ImageBuild package
snapshot；删除 ImageArtifact 时会原子检查 App Revision、Container snapshot 及活跃
rollout 的来源/目标身份。任何引用存在时删除返回冲突并列出 blocker。清理执行也会在
数据库锁内重新检查，不会依据旧 preview 结果强制删除。

旧 `/versions` multipart、build、artifact 和 activate 接口继续兼容历史自动化，
但不再是日常更新入口。

构建器和 Dockerfile 是 Portal 镜像内的代码，不接受管理员上传的命令或
Dockerfile。各槽位的合并规则由对应策略决定，Core 不推断业务包内部目录。

## 安全约束

- 监测、审计和批次管理接口始终 admin-only；仅本人 `failed` 实例的 `start/enter` 恢复入口例外返回该实例恢复批次的公共状态。
- 审计 metadata 会脱敏 `token`、`cookie`、`authorization`、`password` 等字段。
- 不把 外部身份凭据 写入任务、审计或指标；任务结果中的 credential-shaped 字段也会统一脱敏。
- 管理接口返回 request ID，便于在服务日志中定位一次操作。
- 运行时内部 endpoint 不通过监测列表暴露给浏览器。
- `/api/admin/monitor/health` 当前表示 Docker/OrbStack 运行时健康；上游转发使用单独的连通性测试。
