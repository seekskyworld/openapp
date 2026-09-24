# 外部发布检查策略

Core 不内置具体产品的名称、旧文件清单或仓库名。通用编译闭包、兼容入口隔离、
测试与 source map 清理、符号链接限制、前端引用完整性检查仍由 Core 执行。

产品仓库可以通过 `OPENAPP_BOUNDARY_POLICY=/absolute/path/to/policy.json` 显式提供额外策略。
未指定时只执行通用检查，不宣称验证了产品词表。指定文件不存在、格式错误、包含未知字段
或不安全的相对路径时直接失败。

JSON 使用 `schemaVersion: 1`，支持以下字符串数组字段：

- `markers`：禁止出现在通用产物或源码值中的正则表达式。
- `repositoryNames`：跨仓库引用检查使用的额外目录名；当前显式选择的仓库名自动加入。
- `backendPaths`、`runtimePaths`：相对对应编译目录的额外裁剪路径。
- `frontendAssets`、`frontendChunkPrefixes`：额外的旧资产与 chunk 前缀。
- `deploymentPaths`：相对 Core 根目录的禁止部署路径。

该策略供受信任的构建和审计流程使用，不接受最终用户的请求输入。
产品规则与相应回归由外部 Adapter 仓库持有，Core 的通用测试只使用中性夹具。
生产运行时无需读取该策略；组合发布必须由产品仓库执行其自己的验收。

构建裁剪脚本的 `compatibility-manifest.mjs` 和 `boundary-policy.mjs` 必须随脚本一起导出，
Docker 构建上下文也必须包含它们，避免源码目录可运行而独立包缺模块。
