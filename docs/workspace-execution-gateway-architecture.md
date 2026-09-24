# OpenApp Workspace、Execution 与访问网关架构

本文定义 OpenApp 从单一 Docker 容器控制面演进为多 Provider 工作区平台时的目标架构。
它描述的是演进方向，不表示下列模块和数据结构已经全部实现。当前实现细节仍以
[`architecture.md`](architecture.md) 和代码为准。

**设计状态：目标架构，尚未完成验证。** 当前只有 Docker/OrbStack 实现；在第二个真实
Provider、跨 Provider Storage 迁移和故障恢复合同通过验收前，本文不能作为多 Provider
能力已经交付的证明。

具体的拆分顺序、自动测试、项目负责人手工验收、停止条件和回滚要求见
[架构说明](architecture.md)。

## 目标

OpenApp 对用户提供的是持久的 Workspace，而不是 Docker 容器。系统需要在不改变
Workspace 身份、权限、数据和浏览器入口的前提下，支持 Docker、Daytona、
Kubernetes、E2B 或其他执行平台，并把运行环境的地址、凭证和故障细节留在服务端。

架构需要满足以下目标：

- Workspace 是稳定的业务对象，Environment 是可以替换和恢复的执行对象。
- 执行生命周期与浏览器访问链路相互独立，可以分别演进。
- Workspace 数据具有独立身份，不隐含等同于某个 Provider 的 Volume。
- App Revision 描述可运行制品，不把所有执行平台都假设为 Docker/OCI。
- 浏览器只访问 OpenApp 的稳定路径，不直接接触 Provider 地址或凭证。
- 鉴权、唤醒、健康等待、活动跟踪和代理规则只实现一次。
- 新增 Provider 不要求修改 Workspace、发布、权限或前端进入流程。
- 当前单体部署可以逐步迁移，不先引入独立网关进程或分布式调度器。

## 核心术语

| 术语 | 定义 | 不负责 |
| --- | --- | --- |
| Workspace | 用户拥有的持久工作区，关联 App、Revision、资源策略和数据 | Docker 名称、端口和 Provider 命令 |
| Workspace Execution | Workspace 在一个 Provider 上的持久执行槽位；重建或迁移时可与候选和上一槽位并存 | 用户身份、App 发布历史 |
| WorkspaceExecutionManager | 把 Workspace 的期望状态协调为实际执行状态 | HTTP 字节转发和浏览器 Cookie |
| ExecutionControlPort | 创建、观察、协调和删除 Environment 的执行接口 | 访问地址、用户流量和浏览器凭证 |
| AccessTargetResolver | 为已授权访问解析短期私有目标的接口 | 启停、重建和删除 Environment |
| Provider adapter | 对接一个执行平台，并分别满足执行控制与目标解析接口 | Workspace 业务规则和用户授权 |
| Environment | 真正运行程序的对象，例如 Container、MicroVM、VM 或 Host Process | Workspace 业务身份 |
| WorkloadClass | Environment 对 Workspace 提供的生命周期与隔离合同，例如 sandbox 或 dedicated | 底层使用哪种引擎 |
| AccessTarget | Provider 为一次服务端访问解析出的私有目标 | 作为浏览器 URL 或持久公开地址 |
| WorkspaceStorageRef | Workspace 持久数据的稳定身份 | 某次执行中的挂载路径或临时凭证 |
| StorageBinding | 将 WorkspaceStorageRef 附加到某个 Environment 的受信描述 | Workspace 所有权和删除策略 |
| LaunchArtifact | App Revision 可在特定 Provider 上启动的不可变制品 | 选择 Provider 或执行资源策略 |
| WorkspaceGateway | 用户流量进入 Workspace 的访问网关 | 镜像构建、任务批次和资源调度 |
| EdgeIngress | Caddy、Nginx 或云负载均衡器，负责 TLS 和静态路由 | Workspace 所有权、唤醒和 App 登录态 |
| RouteProfile | 代码拥有的一组访问规则 | 由数据库任意定义认证或凭证转发行为 |

`Runtime` 容易同时表示 Node.js Runtime、Docker Runtime 和业务执行对象。目标架构不再
把它作为业务层核心术语，统一使用 `WorkspaceExecution`、`Provider adapter` 与
`ExecutionContract`。`ContainerRuntime` 等现有代码名和外部技术名称仅作为兼容语义
保留。

`Container`、`MicroVM`、`VM` 和 `Host Process` 是 Environment 的运行形态；
`Sandbox` 是隔离与生命周期合同，不是底层技术父类。两者都作为 Provider descriptor
元数据，不设计成继承树。Daytona 是 Sandbox Platform，Docker 是容器引擎，二者都
通过平级 Provider adapter 接入，不需要被强行放在同一分类层级。

## 总体架构

OpenApp 分为四个相互正交的平面：

```text
                                     OpenApp

 Control Plane          Execution Plane          Access Plane          Storage Plane
 ------------------     ---------------------    ------------------    ------------------
 User                   WorkspaceExecutionMgr    EdgeIngress           WorkspaceStorageRef
 Workspace                       |               WorkspaceGateway      StorageBinding
 App / Revision                  v                     |                     |
 LaunchArtifact         ExecutionControlPort           v                     |
 Policy / Audit                  |               AccessTargetResolver        |
 Task Batch                      |                     |                     |
                                +----------+----------+                     |
                                           v                                |
                                  Provider Adapter Registry                 |
                              +------------+------------+                   |
                              v            v            v                   |
                         Docker Adapter Daytona Adapter Kubernetes Adapter   |
                              +------------+------------+                   |
                                           |                                |
                                           v                                v
                                       Environment <------------------ Storage backend
```

控制平面决定谁拥有什么、应该运行哪个 Revision、使用什么策略以及操作是否被允许。
执行平面把期望状态落到某个 Provider。访问平面把经过认证的用户请求安全地送到已经
就绪的 Environment。存储平面维护 Workspace 数据的稳定身份和挂载关系。四个平面
通过窄接口协作，不能共享 Provider 私有细节。

### 依赖方向

四个平面按以下规则协作，避免图上分层、实现中仍通过共享对象反向耦合：

- 控制平面只持有 Workspace、Revision、LaunchArtifact 和策略等稳定身份，不读取
  Provider endpoint、临时凭证或命令输出。
- `WorkspaceExecutionManager` 是唯一分配 generation、发起执行事务和持久化 Execution
  状态的模块；Provider adapter 不直接读写 OpenApp 数据库。
- `WorkspaceExecutionManager` 只依赖 `ExecutionControlPort` 和受信的 StorageBinding、
  LaunchArtifact 输入，不依赖 Gateway、RouteProfile 或浏览器身份。
- `WorkspaceAccessCoordinator` 可以通过 Execution Manager 的窄接口请求“准备就绪”，
  随后调用 `AccessTargetResolver`；它不能选择 Provider、删除 Environment 或推进 rollout。
- `WorkspaceGateway` 只负责授权、活动准入、访问准备和协议转发，不持久化执行状态，也不
  接触 StorageBinding 和 Provider 调度策略。
- 存储模块只根据 WorkspaceStorageRef、目标 Provider 和亲和性产生受信绑定，不理解用户
  路由、Cookie 或 App handoff。
- 组合根负责把同一个 Provider adapter 的不同 port 注入正确调用方；调用方不能取得完整
  adapter 后自行跨越接口边界。

### 部署链路

```text
Browser
  -> Caddy / Cloud Load Balancer
  -> Nginx or Portal Backend
  -> WorkspaceGateway
       -> Portal session and ownership check
       -> activity admission and lease
       -> WorkspaceAccessCoordinator
            -> WorkspaceExecutionManager -> ExecutionControlPort
            -> AccessTargetResolver
       -> AppAuthHandoffCoordinator
       -> HTTP / WebSocket proxy transport
  -> private AccessTarget
  -> Environment
```

Caddy 和 Nginx 只做 TLS、静态文件和固定路径分流。它们不应该查询 PostgreSQL、启动
Environment 或持有下游 App 凭证。当前不需要把 `WorkspaceGateway` 拆成独立服务，
先把它做成 Portal Backend 内的深模块，可以减少网络跳数和迁移风险。

## Workspace 与执行状态

当前 `Container` 同时保存用户的业务实例和 Docker 执行快照。目标模型在逻辑上拆成：

```text
Workspace
  id
  ownerId
  appId
  appRevisionId
  storageRef
  activeExecutionId
  status                active | deleting | deleted
  resourcePolicySnapshot
  createdAt

WorkspaceExecution
  id
  workspaceId
  role                  active | candidate | previous | retired
  providerId
  environmentRef
  desiredGeneration
  deployedGeneration
  healthyGeneration
  transactionId
  transactionStatus
  desiredState
  observedState
  launchArtifactId
  revision
  retiredAt
  updatedAt
```

Workspace 与 WorkspaceExecution 是一对多关系。`WorkspaceExecution` 表示一个
Provider 上的持久执行槽位，不等同于一次 start/stop 请求；同一槽位可以经历多个受
generation 约束的协调事务。正常状态只有一个 `active` 槽位。重建、蓝绿切换或跨
Provider 迁移期间可以临时存在一个 `candidate` 和一个 `previous`，但浏览器访问始终只
解析 `Workspace.activeExecutionId`，并在转发前重新证明该 Execution 已运行且健康。
`activeExecutionId` 表示当前权威基线，不表示 Environment 此刻一定运行或已经产生首次
健康证明。切换 active 指针必须与事务证明一起原子提交，不能仅凭候选 Environment 已
存在就改变入口。

Provider 内部为了原子替换而创建的临时对象不必各自成为 WorkspaceExecution。例如当前
Docker `rebuild-next`、`rebuild-previous` 和 `rebuild-rollback` 仍可由一个 adapter 在同一
Execution 事务内隐藏。只有控制面需要独立持久化、选择或切换的执行槽位，例如跨 Provider
candidate 或长期蓝绿环境，才建立额外 WorkspaceExecution 记录。

持久化层必须约束每个 Workspace 最多一个 `active`、一个 `candidate` 和一个仍在回滚窗口
内的 `previous`；清理 Environment 后把历史槽位标记为 `retired`，而不是让它继续参与调度
或访问解析。`activeExecutionId` 只允许在初次创建尚未完成或 Workspace 正在显式删除时为
空。

第一阶段不要求立即拆表。可以先在模块与类型中建立一对多语义，并用兼容投影表示当前
active Execution；真正需要第二个 Provider、并存候选或执行历史时再拆分持久化。无论
是否拆表，都必须保持以下不变量：

- Workspace ID、所有者和数据卷身份不会因重建而改变。
- 一个 Workspace 最多有一个 active Execution；candidate 不能直接接收用户流量。
- 对 `running` 目标，`activeExecutionId` 只能切到已健康的候选；对显式 `stopped` 目标，
  可以将已部署但 `awaiting_first_start` 的最新代次接受为新基线，Gateway 在首次转发前仍
  必须完成启动和健康验证。
- `environmentRef` 只由 Provider 产生，浏览器不能提交或覆盖。
- 每次协调使用唯一 generation 和 transaction ID，持久化写入同时校验 Execution
  `revision`；旧执行、旧代次和失去租约的 Worker 都不能覆盖新状态。
- `deployedGeneration` 证明当前基线，`healthyGeneration` 单独证明通过健康检查的代次。
- App Revision、LaunchArtifact、StorageBinding 和资源策略是执行代次的不可变输入快照。
- Environment 故障不等于 Workspace 消失。
- 删除前必须验证 Workspace、Environment 和持久存储的所有权。

### 协调状态机

期望状态、实际状态和事务状态是三个正交维度，不能合并成一个宽泛的 `status`：

```text
desiredState     running | stopped
observedState    absent | creating | running | stopped | failed | unknown

transactionStatus
  requested
      |
      v
  progressing ---------> applied
      |                     ^
      +-> awaiting_first_start
      +-> rolled_back
      +-> failed
      +-> inconsistent
```

状态转换遵守以下规范：

- 只有 `WorkspaceExecutionManager` 可以分配更大的 `desiredGeneration` 和新的
  transaction ID；Provider adapter 只能报告观察和证明。
- 相同 transaction ID 的协调可以安全重放，且只能推进同一 generation。
- `desiredGeneration` 单调递增；`deployedGeneration` 不得领先于它，
  `healthyGeneration` 不得领先于 `deployedGeneration`。
- 对 `running` 目标，只有 deployed 与 healthy generation 都等于 desired generation
  才能进入 `applied`。
- 对未启动的 `stopped` 目标，可以进入 `awaiting_first_start`，证明制品已经部署，但不
  伪造健康证明。
- `rolled_back` 必须携带恢复到哪一个 source generation 的证明；缺失该证明时只能进入
  `inconsistent`。
- `failed` 表示已知且可分类的失败；`inconsistent` 表示无法证明当前基线，必须停止自动
  破坏性操作并转人工处理。
- `cancelled` 是协调调用的结果，不是 Environment 状态；取消后 adapter 不得继续发出
  新副作用，但已经被远端 Provider 接受的操作必须由后续 observe/reconcile 对账。

### 停止候选与代次证明

部署完成和健康验证不能合并为一个布尔状态。停止状态的 Workspace 可以已经部署新
代次，但尚未发生首次健康启动：

```text
desiredGeneration  = g3
deployedGeneration = g3
healthyGeneration  = g2
transactionStatus  = awaiting_first_start
```

此时新批次可以显式接受 `g3` 为下一次重建基线，但不能把 `g3` 报告为健康成功。对运行
目标，只有 `deployedGeneration` 与 `healthyGeneration` 都等于目标代次才能完成任务。
Provider 必须以 transaction ID 提供 `requested`、`progressing`、`applied`、
`awaiting_first_start`、`rolled_back`、`failed` 或 `inconsistent` 的可证明结果。Portal
重启后通过同一事务继续对账，不能仅凭 Environment 存在就推断成功。

### 持久化迁移纪律

当前 `containers` 表到 Workspace/Execution 模型的迁移必须可与前后两个应用版本并行，
不能依赖停机期间一次性改表：

1. 先增加 nullable 或带安全默认值的新列，把历史行确定性投影为 `providerId=docker`、
   active Execution 和现有 runtime/storage identity。
2. 新代码先 dual-write 新旧字段，读取时优先新字段并校验与旧字段一致；不一致立即上报，
   不能静默选择任意一侧。
3. 分批 backfill 后核对行数、owner、runtime、image、storage 和 generation，不在回填前添加
   会长时间锁表的强约束。
4. 所有 Execution 写入使用 revision/generation CAS；租约负责减少竞争，CAS 负责最终 fencing，
   两者不能互相替代。
5. 只有旧 Portal 已退出、双写观察窗口通过且回滚演练完成后，才停止旧字段写入并验证
   NOT NULL、唯一 active Execution 等约束。
6. `endpoint` 在 AccessTarget 全链路切换完成前保留兼容读取；停止写入后经过一个版本窗口
   再删除列，避免应用回滚后无法访问 Workspace。

## Workspace 存储

Workspace 的数据身份不能隐含等同于 Docker Volume 名称。目标模型使用稳定的
`WorkspaceStorageRef`，执行时再解析为 Provider 可消费的 `StorageBinding`：

```ts
interface WorkspaceStorageRef {
  id: string;
  storageClass: string;
  affinity?: { providerId: string; region?: string };
}

interface StorageBinding {
  storageId: string;
  attachmentRef: string;
  mountPath: string;
  readOnly: boolean;
}
```

只有 Docker 一个存储实现时，不需要立即建立 `StorageProvider` registry。Docker adapter
可以把 `WorkspaceStorageRef` 解析为现有受管 Volume，但 `DesiredWorkspaceExecution`
必须接收 `StorageBinding`，不能自行从 Workspace ID 猜 Volume。引入第二个存储后端时，
再增加负责创建、快照、恢复、迁移和绑定的深模块。

历史 Docker Volume 可能早于 `storageRef` 标签存在。兼容读取只能作用于 Provider 根据
Workspace ID 解析出的确定性 Volume 名称，并且 managed、instance、owner 三项标签必须全部
匹配；只允许缺少 storageRef，不能接受冲突值或放宽自定义 `attachmentRef`。该兼容规则只覆盖
启动、停止和重建等非存储破坏性生命周期操作，不会自动修改 Volume，也不能授权
`releaseWorkspaceStorage`。存储释放始终要求 managed、instance、owner、storageRef 全部匹配。

`attachmentRef` 是 Provider 可消费的受信绑定，不是 Workspace 的持久身份。若绑定包含
临时凭证，只能在协调期间存在于服务端内存；持久化记录保存稳定 storage ID、后端类型、
亲和性和不含凭证的 Provider 引用。一次迁移可以为同一 `WorkspaceStorageRef` 临时建立
多个 StorageBinding，但只有通过完整性校验的绑定才能交给 candidate Execution。

跨 Provider 迁移不是简单地切换 `providerId`。系统必须先证明目标 Provider 能消费
当前 StorageBinding，或完成显式快照与恢复。若 Workspace 使用带 Provider affinity 的
本地存储，调度器必须保持亲和性并明确报告暂不支持迁移，不能宣称无损替换。

停止、重建或删除 WorkspaceExecution 只处理 Environment 与临时网络，不能隐式删除
WorkspaceStorageRef。只有显式删除 Workspace 的控制平面流程可以在 Environment 清理
完成、所有权复核且没有其他引用后释放存储。当前 `ContainerRuntime.remove` 同时删除
容器与 Volume，迁移时必须在内部拆成 `removeEnvironment` 和
`releaseWorkspaceStorage`，再由现有完整删除流程按顺序调用。前者必须以“Environment
已经不存在”为幂等成功，且无论成功或失败都不能释放 WorkspaceStorageRef。

Workspace 删除使用持久状态机，不把多个破坏性动作包装成无法恢复的内存流程：

```text
active
  -> deleting and deny new access/reconcile
  -> drain activity
  -> remove every non-retired Environment
  -> verify no live Execution or StorageBinding reference remains
  -> release WorkspaceStorageRef
  -> deleted tombstone
```

任一步失败都保留 `deleting`、失败阶段和 transaction ID，由同一请求安全重试。存储释放
失败时 Workspace 不能标记为 deleted；存储已释放但最终数据库写入失败时，重试必须把
“storage already absent”视为幂等成功。deleted tombstone 至少保留审计和幂等窗口，防止旧
请求或失去租约的 Worker 重新创建 Environment。

## LaunchArtifact

当前 `ImageArtifact` 是 OCI/Docker 语义。目标控制面用 `LaunchArtifact` 描述执行制品：

```ts
interface LaunchArtifact {
  id: string;
  kind: "oci_image" | "vm_image" | "package" | "provider_template";
  immutableReference: string;
  executionContract: string;
  platformTargets: ReadonlyArray<{ os: string; architecture: string }>;
  /** 只有 Provider 专属模板需要固定 family；通用 OCI 制品不设置。 */
  providerFamily?: string;
}
```

现有 ImageArtifact 作为 `kind=oci_image` 的兼容实现继续使用。Docker、Kubernetes 和部分
Sandbox Provider 可以共享 OCI 制品；VM、SSH Host 或 Provider template 只有在真实
需求出现时才增加构建 adapter。执行协调在产生任何 Provider 副作用前验证制品类型、
平台、Execution contract 和 Provider 能力。通用制品不能保存 Provider ID 白名单，否则
每接入一个兼容 Provider 都要回写历史制品；只有真正专属的 template 才固定
`providerFamily`。

镜像的 list、resolve、pull、load、smoke validate 和 delete 属于 Artifact/Build 模块，
不能重新进入 `ExecutionControlPort`。Provider adapter 只接收已经解析为不可变引用且通过
控制面校验的 LaunchArtifact，并在执行副作用前做最后一次 Provider 兼容性校验。只有第二
个 Provider 确实需要异步准备制品时，才引入对应的 Artifact preparation 接口边界。

## Provider adapter 层与接口边界

Provider adapter 是执行平台真正变化的位置，但执行平面和访问平面不能共享一个宽
接口。同一个 Docker、Daytona 或 Kubernetes adapter 分别满足两个接口：

```ts
type ProviderFailureClass = "transient" | "permanent" | "inconsistent" | "cancelled";
type ProviderFailurePhase =
  | "validate"
  | "observe"
  | "prepare_artifact"
  | "prepare_storage"
  | "provision"
  | "start"
  | "health"
  | "stop"
  | "cutover"
  | "rollback"
  | "remove"
  | "resolve_access";
type ExecutionTransactionStatus =
  | "requested"
  | "progressing"
  | "applied"
  | "awaiting_first_start"
  | "rolled_back"
  | "failed"
  | "inconsistent";

interface WorkspaceExecutionRef {
  workspaceId: string;
  executionId: string;
  providerId: string;
  expectedOwnerId: string;
  environmentRef?: string;
}

interface ExecutionObservation {
  environmentRef?: string;
  observedState: "absent" | "creating" | "running" | "stopped" | "failed" | "unknown";
  workloadHealth: "unknown" | "starting" | "healthy" | "unhealthy";
  deployedGeneration?: number;
  healthyGeneration?: number;
  transactionId?: string;
  transactionStatus?: ExecutionTransactionStatus;
}

interface DesiredWorkspaceExecution {
  ref: WorkspaceExecutionRef;
  generation: number;
  transactionId: string;
  desiredState: "running" | "stopped";
  launchArtifact: LaunchArtifact;
  storageBindings: readonly StorageBinding[];
  resourcePolicy: ResourcePolicySnapshot;
  rollbackSource?: { executionId: string; generation: number };
}

interface ProviderFailure {
  class: ProviderFailureClass;
  code: string;
  phase: ProviderFailurePhase;
  retryAfterMs?: number;
  /** 只允许不含凭证、可供管理员关联远端操作的 opaque reference。 */
  providerOperationRef?: string;
}

interface ReconcileResult {
  status: ExecutionTransactionStatus;
  observation: ExecutionObservation;
  providerOperationRef?: string;
  retryAfterMs?: number;
  failure?: ProviderFailure;
}

interface EnvironmentRemovalRequest {
  ref: WorkspaceExecutionRef;
  generation: number;
  transactionId: string;
}

interface EnvironmentRemovalResult {
  status: "progressing" | "removed" | "failed" | "inconsistent";
  providerOperationRef?: string;
  retryAfterMs?: number;
  failure?: ProviderFailure;
}

interface ExecutionControlPort {
  observe(ref: WorkspaceExecutionRef, signal?: AbortSignal): Promise<ExecutionObservation>;

  reconcile(
    desired: DesiredWorkspaceExecution,
    signal?: AbortSignal,
  ): Promise<ReconcileResult>;

  removeEnvironment(
    request: EnvironmentRemovalRequest,
    signal?: AbortSignal,
  ): Promise<EnvironmentRemovalResult>;
}

type WorkspaceLogicalService = "workspace_ui" | "mcp_sandbox_asset";
type AccessTargetResolution =
  | { status: "resolved"; target: AccessTarget }
  | { status: "failed"; failure: ProviderFailure };

interface AccessTargetResolver {
  resolveAccessTarget(
    ref: WorkspaceExecutionRef,
    service: WorkspaceLogicalService,
    signal?: AbortSignal,
  ): Promise<AccessTargetResolution>;
}
```

`reconcile` 隐藏创建、启动、停止、重建、候选验证和回滚的 Provider 细节。期望状态
必须包含 Workspace、所有者、LaunchArtifact、StorageBinding、资源策略、目标运行状态、
generation 和 transaction ID。Provider adapter 负责幂等执行、代次 fencing 和事务证明。

一次 `reconcile` 是有截止时间的一次收敛步骤，不保证远端长操作在同一次调用内完成。
Daytona、Kubernetes 等 Provider 可以返回 `progressing`、稳定的非敏感 operation reference
和 `retryAfterMs`，由 Worker 使用同一 transaction ID 继续对账。接口还必须保证：

- 相同 transaction ID 和 generation 可以安全重放，不重复创建 Environment。
- 旧 generation 在产生副作用前被拒绝，不能覆盖已部署或已健康的新代次。
- 已知 Provider 失败通过 `ProviderFailure` 分类，调用方不能解析异常消息决定重试。
- `transient` 保持事务为 `progressing` 并按预算重试；`permanent` 进入 `failed` 并直接转
  人工处理；`inconsistent` 进入同名状态并冻结破坏性操作；`cancelled` 不改变已持久化的
  事务证明，也不消耗失败预算。
- `AbortSignal` 触发后不再发出新的 Provider 副作用；已经被远端接受的操作由后续
  observe/reconcile 继续证明。
- `removeEnvironment` 只清理 Environment 及 Provider 私有的临时网络、隧道和候选资源，
  不释放 WorkspaceStorageRef、不修改 Workspace 应用数据，也不接触共享 LaunchArtifact。若
  Workload 的执行锁或 fencing 元数据随 StorageBinding 持久化，Provider 可以在完整归属校验并
  停止全部相关 Environment 后，仅清理这些由 Execution 产生的协调元数据，保证 Storage 可安全
  脱离并重新绑定；该权限不包含删除、迁移或重新分配 Workspace Storage。

`WorkspaceExecutionManager` 只持有 `ExecutionControlPort`，不能解析网络目标。
`WorkspaceAccessCoordinator` 在执行就绪后使用 `AccessTargetResolver`，不能重建或删除
Environment。两个接口可以由同一个进程内 adapter 实现；这里分离的是调用方权限和
知识，不是部署进程。

这是目标接口，不要求一次性替换当前 `ContainerRuntime`。迁移期间可以由一个
`DockerProviderAdapter` 调用现有 Docker 实现。只有当 Daytona、Kubernetes 等第二个
真实 adapter 落地时，才需要引入 Provider registry 和调度选择，避免先建立只有一层
转发的空接口。

指标、诊断和 Provider 健康是独立的只读能力，不扩宽核心执行接口：

```ts
interface ExecutionMetricsPort {
  sample(ref: WorkspaceExecutionRef, signal?: AbortSignal): Promise<ExecutionMetrics>;
}

interface ExecutionDiagnosticsPort {
  diagnose(ref: WorkspaceExecutionRef, signal?: AbortSignal): Promise<ExecutionDiagnostics>;
}

interface ProviderHealthPort {
  check(signal?: AbortSignal): Promise<ProviderHealth>;
}
```

Provider registry 可以按 descriptor 暴露这些可选 port，但 Lifecycle、Gateway 和 Rollout
不能因此依赖一个万能 Provider 对象。不支持某项指标时应报告 `unsupported`，不能把它
计为 Environment 或 Provider 故障。

Provider registry 使用扁平能力描述，不使用 Environment 继承树：

```ts
interface ProviderCapabilities {
  rollback: "transactional" | "best_effort" | "none";
  workloadHealth: "native" | "probe" | "none";
  metrics: boolean;
  diagnostics: boolean;
}

interface ProviderDescriptor {
  descriptorVersion: 1;
  id: string;
  environmentKind: "container" | "microvm" | "vm" | "host_process" | "opaque";
  workloadClass: "sandbox" | "dedicated";
  accessMode: "direct_http" | "provider_proxy" | "tunnel";
  supportedArtifactKinds: ReadonlyArray<LaunchArtifact["kind"]>;
  supportedExecutionContracts: readonly string[];
  supportedStorageClasses: readonly string[];
  resourceLimits: {
    minMemoryBytes?: number;
    maxMemoryBytes?: number;
    minCpuMillis?: number;
    maxCpuMillis?: number;
  };
  capabilities: ProviderCapabilities;
}
```

调度器只根据 Workspace 需求、Storage affinity、LaunchArtifact 要求和 descriptor 选择
Provider，不读取 adapter 内部使用 Docker、containerd、Firecracker 或 SSH 的细节。
Descriptor 是版本化、代码拥有的合同，不允许数据库注入任意 capability 字符串。制品、
Execution contract、Storage class、资源范围、访问模式和必要的 rollback/health 能力必须
在创建 Environment 前全部匹配；不兼容时不能先创建再补偿。

### AccessTarget

`AccessTarget` 是短期、服务端私有的连接描述：

```ts
interface AccessTarget {
  protocol: "http" | "https";
  baseUrl: string;
  service: WorkspaceLogicalService;
  issuedAt: string;
  sourceExecutionId: string;
  sourceEnvironmentRef: string;
  authority?: string;
  headers?: Readonly<Record<string, string>>;
  expiresAt?: string;
}
```

不同 AccessTargetResolver 可以用不同方式产生它：

| Provider adapter | AccessTarget 示例 |
| --- | --- |
| Docker | Portal 可达的实例网络地址或本机映射端口 |
| Daytona | 带服务端临时授权信息的 Sandbox 入口 |
| Kubernetes | 集群内 Service DNS 或受控 apiserver proxy 目标 |
| E2B | 短期 Sandbox URL 与服务端 Header |
| SSH | Portal 管理的本地 tunnel endpoint |

`AccessTarget` 不写入浏览器响应、URL、审计详情或普通日志。需要持久化的只有不含凭证
的 `environmentRef`。Gateway 在每次新连接或目标过期后重新解析，避免使用失效端口或
签名 URL。`baseUrl` 禁止包含用户名或密码，Headers 只能应用于匹配的 logical service，
且必须在代理前剥离同名浏览器 Header。HTTP/SSE 在目标过期后为新请求重新解析；
WebSocket 在握手时固定一次目标和凭证，连接存续期间不静默切换上游。执行任务、rollout
和清理模块不持有 `AccessTargetResolver`。解析失败返回稳定 `ProviderFailure`；Gateway
只根据 failure class、safe code 和 retryAfter 决定用户错误与重试，不接触 SDK 异常文本。

## WorkspaceGateway

`WorkspaceGateway` 是访问平面的深模块。Portal HTTP 路由只需要把普通请求和 Upgrade
请求交给它：

```ts
interface WorkspaceGateway {
  handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>;
}
```

Gateway 内部统一完成：

1. 解析受支持的 Workspace 路由和 RouteProfile。
2. 校验 Origin、Portal Session、Workspace 所有权与请求方法。
3. 在任何 Execution 同步或唤醒前取得 drain-aware 活动租约。
4. 合并同一 Workspace 的并发唤醒，等待 Environment 健康。
5. 通过 `AccessTargetResolver` 获取服务端私有 `AccessTarget`。
6. 选择代码拥有的 `AppAuthHandoff`，清除控制面和其他 App 的凭证。
7. 转发 HTTP、SSE 和 WebSocket，并处理 Header、Cookie、Location 与路径重写。
8. 在连接存续期间续租活动记录，连接中止时终止上游请求。
9. 把内部故障映射为稳定的用户错误和可关联的管理员诊断。

`proxy.ts` 可以保留为 Gateway 内部的 HTTP/WebSocket transport 实现。它不再由
`portal-app.ts`、MCP 路由或其他调用方直接组合安全选项，从而避免不同入口遗漏 Header
过滤、活动租约或中止信号。

### RouteProfile

当前至少存在两类访问合同，应由代码固定：

| Profile | 身份与所有权 | 方法和协议 | 唤醒 | Cookie |
| --- | --- | --- | --- | --- |
| `workspace_ui` | Portal Session，加 Workspace owner 校验 | HTTP、SSE、WebSocket | 按进入/自动唤醒策略 | 只允许对应 App handoff 声明的 Cookie |
| `mcp_sandbox_asset` | 独立 Sandbox host 和受限资源路径 | GET、HEAD | 不自动唤醒 | 剥离全部浏览器 Cookie |

RouteProfile 可以作为 Gateway 内部数据，但不能由管理员在数据库中创建任意认证规则。
数据库配置只能启停已审核的 Profile 或调整非敏感策略。新增 Profile 必须经过代码审查
和合同测试。

### 正常访问时序

```text
Browser          WorkspaceGateway   AccessCoordinator   ExecutionManager   TargetResolver
   |                    |                   |                    |                 |
   | GET /instances/W/  |                   |                    |                 |
   |------------------->| authenticate      |                    |                 |
   |                    | acquire activity  |                    |                 |
   |                    |------------------>| prepare W          |                 |
   |                    |                   |------------------->| ensure ready    |
   |                    |                   |<-------------------| ready + proof   |
   |                    |                   |------------------------------------->| resolve
   |                    |                   |<-------------------------------------| target
   |                    |<------------------| prepared access    |                 |
   |                    | App auth + proxy  |                    |                 |
   |<================================================================================>|
```

显式“进入工作区”接口可以先调用同一个 `WorkspaceAccessCoordinator` 做准备，再返回稳定的
Portal 路径。浏览器随后访问该路径时，Gateway 仍执行完整授权；预热结果只能优化延迟，
不能替代访问校验。

### WebSocket 与 SSE

HTTP 与 WebSocket 必须共享相同的授权、Origin、App handoff、活动租约和 AccessTarget
解析规则。Node.js 的 Upgrade 事件可以保留独立 adapter，但不能复制一套业务编排。
SSE 按长连接 HTTP 处理，并持续更新活动租约。升级 drain 生效后拒绝新连接，并通过
租约信号关闭当前 Portal 持有的连接。

## IngressPolicy 与 EgressPolicy

当前 `ForwardingPolicyManager` 管理的是 Portal 公开入口和浏览器 Origin：

- `targetBaseUrl` 实际是 Portal 的公开基础地址。
- `allowedHosts` 实际用于匹配允许的浏览器 Origin。
- `enabled` 控制 Workspace 代理入口是否启用。

这些字段不描述 Environment 上游路由，也不描述实例出站访问。目标命名应为：

```text
ForwardingPolicyManager -> PortalIngressPolicyManager
targetBaseUrl           -> publicBaseUrl
allowedHosts            -> allowedOrigins
```

可以先保留数据库列和旧 DTO 作为兼容层，再迁移管理台与 CLI 文案。实例出站网络应使用
独立的 `EgressPolicy`，不能复用 Origin 白名单。Caddy/Nginx 路由属于部署配置，也不应
写进 IngressPolicy。

## 安全不变量

WorkspaceGateway、ExecutionControlPort、AccessTargetResolver 和存储模块必须共同保证：

- Workspace 所有权校验发生在 Provider 查询、唤醒和目标解析之前。
- Provider 地址、临时凭证、内部 DNS、端口和环境 ID 不会返回普通用户。
- 执行任务不能访问 AccessTarget，Gateway 不能调用 reconcile 或 removeEnvironment。
- StorageBinding 只来自受信存储记录，不能从浏览器路径或挂载参数构造。
- LaunchArtifact 必须通过 Provider、平台和 Execution contract 兼容性检查。
- `Authorization`、管理员令牌和 Portal Session 不会转发到 Environment。
- App Cookie 只能由代码注册的 handoff adapter 声明和处理。
- 上游目标只接受 Provider 产生的受信 `AccessTarget`，不能从请求参数拼接，防止 SSRF。
- 同源重定向才能改写回 Workspace 路径；外部 Location 保持原值或按 Profile 拒绝。
- Cookie 默认限定 Workspace 路径；只有经过审核的 App Cookie 可以使用根路径。
- 维护 drain 建立后不再接纳新活动，避免代理流量与重建事务并发。
- 请求取消、租约失效和 Gateway 超时必须向 Provider transport 传播 `AbortSignal`。
- 用户错误只暴露 Workspace ID、稳定错误码和 request ID；Provider 日志仅对管理员可见。
- 任何无法确认身份、所有权、Profile 或目标来源的情况都必须 fail closed。

## 错误与可观测性

用户页面不应要求理解 Docker、App 镜像或 Provider。Gateway 对外返回稳定阶段：

| 用户阶段 | 示例错误码 | 用户行为 |
| --- | --- | --- |
| 查找 Workspace | `workspace_not_found` | 自动创建已开启时进入创建流程，否则联系管理员 |
| 等待可用 | `workspace_starting` | 页面按 `retryAfterMs` 自动重试 |
| 维护中 | `workspace_maintenance` | 等待后重试 |
| 启动失败 | `workspace_start_failed` | 允许触发受控恢复，超过预算转人工处理 |
| Provider 不可用 | `workspace_provider_unavailable` | 显示 request ID 和重试按钮 |
| 代理失败 | `workspace_gateway_error` | 显示 Workspace ID、request ID 和重试按钮 |

Provider adapter 在接口处把实现错误归一化，控制面和 Worker 不解析 Docker stderr、HTTP
消息或 SDK 异常文本：

| Failure class | 含义 | 默认动作 |
| --- | --- | --- |
| `transient` | 限流、短时网络故障、Provider 暂不可用 | 遵循 `retryAfterMs` 和任务预算重试 |
| `permanent` | 制品、资源、权限或能力确定不兼容 | 不消耗无意义重试，直接转人工处理 |
| `inconsistent` | 现有 Environment、generation 或事务关系无法证明 | 冻结破坏性操作并保留现场 |
| `cancelled` | 调用方取消或租约丢失 | 不计失败预算，后续对已接受操作继续对账 |

稳定错误至少包含 safe code、失败 phase、failure class、可选 `retryAfterMs` 和不含凭证的
provider operation reference。原始 Provider 日志、响应正文、临时 URL 和 Header 只进入
受权限控制且经过脱敏的管理员诊断。多 Provider 监控按 Provider 分开报告健康和容量；
某个 adapter 不支持指标时记录 `unsupported`，不能把缺少指标当成零值或平台故障。

管理员诊断应关联：

- request ID、Workspace ID、owner ID 和 RouteProfile；
- provider ID、environmentRef、desired/deployed/healthy generation 和 transaction ID；
- 失败阶段：authorize、admit、wake、health、resolve target、connect 或 stream；
- 上游状态、退出码、OOM、健康状态和脱敏日志尾部；
- 自动恢复次数、下次重试时间和是否已转人工处理。

用户界面不显示不存在的临时容器编号。Environment ID 仅在管理员诊断中展示，普通用户
始终使用稳定 Workspace ID。

## 当前代码到目标模块的映射

| 当前代码 | 目标归属 | 迁移动作 |
| --- | --- | --- |
| `models.ts` 中的 `Container` | `Workspace` + `WorkspaceExecution` | 先拆类型语义，必要时再拆表 |
| `InstanceLifecycle` | `WorkspaceExecutionManager` | 保留策略、持久化和事务协调，逐步改为 Provider 无关命名 |
| `ContainerRuntime` | 核心执行/访问接口及可选观测能力的兼容来源 | 生命周期收敛为两个核心接口，指标和诊断按 capability 分离 |
| `DockerCliRuntime` | `DockerProviderAdapter` | 同时满足两个接口，继续隐藏网络、Volume、标签和替换事务 |
| `Container.endpoint` | 短期 `AccessTarget` | 停止作为持久业务字段使用，由 resolver 按需产生 |
| Docker 受管 Volume | `WorkspaceStorageRef` + `StorageBinding` | 先建立稳定身份和现有 Volume 映射，不立即增加 registry |
| `ContainerRuntime.remove` | `removeEnvironment` + `releaseWorkspaceStorage` | 内部拆开职责，由显式 Workspace 删除流程按顺序编排 |
| Runtime 镜像操作 | Artifact/Build 模块 | 与执行控制分离，Provider 只消费已校验的不可变 LaunchArtifact |
| `ImageArtifact` | `LaunchArtifact(kind=oci_image)` | 保留兼容实现，非 OCI Provider 出现后再扩展制品类型 |
| `runtimeContract` | `executionContract` | 目标模型改名，现有字段与持久化名称作为兼容投影保留 |
| rollout `attemptId` 与 Runtime 事务检查 | generation 与 transaction proof | 保留 crash recovery，并区分 deployed/healthy generation |
| `InstanceRuntimeCoordinator` | `WorkspaceAccessCoordinator` | 通过 ExecutionManager 准备就绪，仅直接持有目标解析接口 |
| `portal-app.ts` 的 HTTP 与 Upgrade 代理编排 | `WorkspaceGateway` | 移出路由文件，通过网关接口调用 |
| `proxy.ts` | Gateway 内部 transport | 保留协议实现，禁止业务调用方自行组合安全参数 |
| `AppAuthHandoffCoordinator` | Gateway 内部依赖 | 保持独立模块和代码拥有的 adapter registry |
| `WorkspaceGateway` 的 MCP Sandbox 分支 | `mcp_sandbox_asset` RouteProfile | 合并公共代理机制，保留更严格合同 |
| `ForwardingPolicyManager` | `PortalIngressPolicyManager` | 逻辑改名，数据库与 DTO 分阶段兼容 |
| Caddy / Nginx | `EdgeIngress` adapter | 保持简单固定路由，不承担 Workspace 逻辑 |

## 分阶段实施

### 第一阶段：收敛访问网关，不改变行为

1. 为现有普通实例代理和 MCP Sandbox 补齐网关级合同测试。
2. 新建进程内 `WorkspaceGateway`，把 HTTP 与 Upgrade 编排从 `portal-app.ts` 移入。
3. 把 `proxy.ts` 降为 Gateway 内部实现。
4. 以两个代码拥有的 RouteProfile 替代两套散落流程。
5. 保留现有 URL、Cookie、错误码和部署拓扑，完成无行为变化验收。

### 第二阶段：整理命名与模型

1. 将 `InstanceRuntimeCoordinator` 的主名称改为 `WorkspaceAccessCoordinator`，保留兼容别名。
2. 将转发策略的代码命名改为 IngressPolicy，先兼容旧数据库列和管理接口。
3. 在类型中建立 Workspace 1:N WorkspaceExecution、active/candidate/previous/retired 角色和
   `activeExecutionId`，不立即做破坏性数据库迁移。
4. 将现有 `containers` 行兼容投影为 Docker active Execution；为 provider、environment、
   storage 和 generation 字段建立 nullable/default 的 dual-read/dual-write 迁移。
5. 增加 desired、deployed、healthy generation、transaction proof 和 Execution revision
   CAS；旧 Portal 或旧 Worker 不能覆盖新代次。
6. 迁移期间保留 `runtime_id` 与 `endpoint` 兼容读路径，确认所有调用方切换后再停止写入。
7. 日志和管理员诊断同时记录 Workspace ID、Execution ID 与 environmentRef。

### 第三阶段：分离 Provider 接口

1. 让 Docker adapter 分别实现 `ExecutionControlPort` 与 `AccessTargetResolver`。
2. 让 WorkspaceExecutionManager 只持有执行接口，Gateway 侧只通过访问协调器解析目标。
3. 用有截止时间的 `reconcile` 包装现有 provision/start/stop/rebuild 事务，保持 rollout
   fencing、停止候选、首次健康启动和每个崩溃窗口的恢复语义。
4. 保留 attemptId 对账，并返回 deployed/healthy generation、transaction status、稳定
   failure class 和可选 retryAfter。
5. 将指标、诊断和 Provider 健康从核心执行接口拆成可选只读 port；将镜像操作迁移到
   Artifact/Build 模块。
6. 将 AccessTarget 设为按 logical service 解析的短期内存值，增加来源、协议、过期、
   Header scope 和 SSRF 校验；HTTP 与 WebSocket 先保持现有行为并行验收。
7. 分别通过执行控制、目标解析和可选能力的合同测试验证 Docker adapter。

### 第四阶段：稳定存储与启动制品

1. 为每个现有 Workspace 建立稳定 storageRef，并映射到当前受管 Docker Volume。
2. 先 dual-read 并校验所有历史 Volume 的 managed、实例、owner 和 storageRef 标签；仅对
   确定性旧 Volume 兼容缺失 storageRef，冲突值和自定义 attachment 继续 fail closed。再让期望
   执行显式接收 StorageBinding；Provider 不再自行猜测 Volume 名称。
3. 将 `removeEnvironment` 与 `releaseWorkspaceStorage` 拆开，由现有完整删除流程顺序编排；
   单独删除 Execution 的测试必须证明 Volume 完整保留。
4. 将现有 ImageArtifact 投影为 OCI LaunchArtifact，不改变当前构建和发布行为。
5. 在 Provider 副作用前校验 LaunchArtifact 与 StorageBinding 兼容性。
6. 对存储释放增加引用复核、审计、幂等重试和恢复演练；迁移失败时保留原 storageRef。
7. 第二个存储后端或非 OCI 制品出现前，不实现空的 StorageProvider 与 artifact registry。

### 第五阶段：接入第二个 Provider

1. 选择一个真实 Daytona 或 Kubernetes 试点，不先实现所有 Provider。
2. 增加 Provider registry、版本化能力描述和 Workspace 的固定 Provider 选择。
3. 首期只将新 Workspace 放到新 Provider；Provider 临时不可用时不能静默迁移已有
   Workspace。
4. 明确新 Provider 的凭证轮换、限流、超时、异步 operation、存储亲和性和
   LaunchArtifact 支持范围。
5. 对两个真实 Provider 运行相同的执行控制、目标解析、Gateway、重启恢复和故障注入
   合同测试。
6. 未完成下一阶段前，产品只宣称“多 Provider 放置”，不宣称“无损跨 Provider 迁移”。

### 第六阶段：单独验证跨 Provider 迁移（可选）

只有容量、地域或故障域产生真实迁移需求时才进入本阶段。迁移协议必须显式执行：

```text
drain and quiesce source
  -> snapshot
  -> transfer or restore target storage
  -> integrity check
  -> create candidate Execution
  -> first healthy proof
  -> atomically switch activeExecutionId
  -> retain rollback window
  -> release previous Environment
```

任一步无法证明时保持原 active Execution 和 storageRef，不允许用“目标 Environment 已
创建”推断迁移成功。只有完整性校验、入口原子切换、回滚和故障恢复演练全部通过后，才
能对外声明支持该 Storage class 的跨 Provider 迁移。

### 第七阶段：按规模决定是否拆分部署

只有当代理带宽、连接数、独立扩缩容或安全隔离成为真实瓶颈时，才把
`WorkspaceGateway` 拆成单独进程。拆分后 Portal 与 Gateway 之间需要短期签名的访问
票据，Gateway 仍不能接受浏览器声明的 owner、Provider 或目标地址。

## 验收标准

访问网关重构至少验证：

- 普通 HTTP、POST body、SSE 和 WebSocket 均通过统一授权链路。
- 并发 HTML、JS、CSS 请求只触发一次 Workspace 唤醒。
- 未登录用户、非 owner、非法 Origin 和未知 RouteProfile 在接触 Provider 前被拒绝。
- Portal Session、管理员令牌和其他 App Cookie 不会到达 Environment。
- Set-Cookie、Location 和 WebSocket 握手保持现有兼容行为。
- 手动停止、自动唤醒、维护 drain、请求取消和健康超时保持现有语义。
- MCP Sandbox 只接受独立域名上的受限 GET/HEAD 资源，不携带 Cookie，也不自动唤醒。
- Docker 与第二个 Provider 对同一 WorkspaceGateway 测试产生一致的用户结果。
- AccessTarget 不出现在普通 JSON、浏览器 URL、数据库快照或未脱敏日志中。
- WorkspaceExecutionManager 的依赖中不存在 AccessTargetResolver。
- WorkspaceGateway 与 WorkspaceAccessCoordinator 不能调用 Provider 的 reconcile/removeEnvironment。
- 同一 Workspace 最多一个 active Execution；candidate 在原子切换前不能接收用户流量。
- activeExecutionId 切换与 candidate 事务证明一起提交；running 目标要求健康证明，
  stopped 目标允许显式接受 awaiting-first-start 的最新已部署基线。
- 同一 generation 的 reconcile 可安全重放，旧 generation 不能覆盖新代次。
- 长 Provider 操作返回 progressing/retryAfter，并能在 Portal 重启后继续对账。
- transient、permanent、inconsistent 和 cancelled 不依赖错误字符串即可得到不同处理。
- 停止候选能证明 deployed generation，但不会伪造 healthy generation。
- 重建前后 storageRef 保持不变，StorageBinding 的所有权和挂载目标经过校验；仅缺 storageRef
  的确定性历史 Volume 可以继续运行，但在完成显式迁移前不能释放。
- 单独删除 WorkspaceExecution 不会释放 Workspace storage；完整删除仍按正确顺序清理。
- Workspace 进入 deleting 后拒绝新访问和新协调；所有 Environment 消失且引用复核完成前
  不调用 releaseWorkspaceStorage，释放失败也不标记为 deleted。
- 不兼容的 LaunchArtifact 在产生 Provider 副作用前被拒绝。
- 镜像构建、解析和清理不通过 ExecutionControlPort；缺少可选指标只报告 unsupported。
- Docker 与第二个真实 Provider 通过同一套 adapter 合同、Provider 故障注入和重启恢复测试。
- 未完成 snapshot、restore、完整性校验和回滚证明时，跨 Provider 迁移保持禁用。
- 用户错误始终包含稳定 Workspace ID 和 request ID，管理员可追溯到 Environment。

## 目标架构完成定义

本文的结构完整不等于多 Provider 能力已经交付。只有同时满足以下条件，目标抽象才算
完成验证：

- Workspace/Execution 基数、状态机、generation、事务、删除和错误合同没有依赖实现猜测
  的未决语义。
- 核心接口保持小而深；Artifact、Storage、Access 和可选观测能力没有回流到万能 Provider
  接口。
- Docker adapter 通过现有重建恢复矩阵以及新的执行、访问、存储删除合同测试。
- 至少一个真实 Daytona、Kubernetes 或同等级第二 Provider 通过同一套合同和故障注入；
  只有 fake adapter 不能证明接口边界成立。
- PostgreSQL dual-read/dual-write、generation CAS、旧版本回滚和多 Portal 并发经过部署演练。
- Provider outage、限流、凭证失效、超时、取消和部分成功都能归一化、重试或转人工处理。
- 只有经过单独数据完整性与回滚验收的 Storage class 才声明支持跨 Provider 迁移。

## 明确不做

- 不把 Workspace 等同于 Container、Sandbox 或 VM。
- 不让浏览器选择 Provider、Environment、endpoint 或转发 Header。
- 不将 App 认证、Cookie 名称或 RouteProfile 开放为任意数据库配置。
- 不把 Caddy、Nginx、Docker 和 Daytona 放进同一个继承层次。
- 不为了架构形式立即拆分微服务、重写持久化或迁移现有实例。
- 不在第二个存储实现出现前建立只有一个 adapter 的 StorageProvider registry。
- 不在非 OCI Provider 出现前重写现有 ImageArtifact 与构建流程。
- 不把镜像构建、遥测、诊断和 Provider 健康重新塞进 ExecutionControlPort。
- 不因 Provider 暂时不可用而静默改变已有 Workspace 的 providerId。
- 不在 Storage 迁移协议通过验收前宣称支持无损跨 Provider 迁移。
- 不把浏览器 Origin 白名单当作 Environment 出站访问策略。

这套结构的核心是相互隔离的执行控制与目标解析接口：执行平面负责“Workspace 在哪里
以及如何运行”，访问平面负责“经过授权的请求如何安全到达它”，存储平面负责“数据
如何在执行代次之间保持身份”。LaunchArtifact 定义 Provider 能运行什么。只有目标
Provider 同时满足制品与存储合同，Environment 才能被安全替换；浏览器入口和 Workspace
产品身份始终不随底层变化。
