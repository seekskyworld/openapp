# Runtime 测试边界

`src/testing/` 下的文件只参与开发期测试，不属于 Runtime 发布入口。
通用配置测试使用 `GENERIC_RUNTIME_PROFILE`；生命周期与兼容场景使用
`sample-profile.ts` 的中性示例合同。具体产品夹具由外部 Adapter 仓库维护。`tsconfig.generic.json`
只编译 `src/index.ts`，因此这些夹具不会进入 generic Runtime 产物。
