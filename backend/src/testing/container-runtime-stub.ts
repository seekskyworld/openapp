import type { ContainerRuntime } from "../runtime.js";

export interface ContainerRuntimeStubOptions {
  /** 测试用存储挂载点；默认值必须与通用 Runtime 一致。 */
  readonly storageMountPath?: string;
  /** 测试用附件命名空间；不应使用产品名称作为隐式默认值。 */
  readonly storageAttachmentPrefix?: string;
}

/**
 * 创建 Provider/生命周期测试替身。替身默认模拟 generic Runtime；需要覆盖
 * 历史产品合同的测试必须显式传入 `storageMountPath` 等选项，避免兼容值从
 * 公共 fixture 渗入新的测试。
 */
export function createContainerRuntimeStub(
  overrides: Partial<ContainerRuntime>,
  options: ContainerRuntimeStubOptions = {},
): ContainerRuntime {
  const storageMountPath = options.storageMountPath ?? "/var/lib/openapp";
  const storageAttachmentPrefix = options.storageAttachmentPrefix ?? "test-data-";
  return {
    resolveStorageBinding: overrides.resolveStorageBinding ?? (async (request) => ({
      storageId: request.storageId,
      attachmentRef: `${storageAttachmentPrefix}${request.workspaceId}`,
      mountPath: storageMountPath,
      readOnly: false,
    })),
    provision: overrides.provision ?? unsupported("provision"),
    get: overrides.get ?? unsupported("get"),
    start: overrides.start ?? unsupported("start"),
    stop: overrides.stop ?? unsupported("stop"),
    sampleActivity: overrides.sampleActivity ?? unsupported("sampleActivity"),
    remove: overrides.remove ?? unsupported("remove"),
    ...overrides,
  };
}

function unsupported<T>(operation: string): () => Promise<T> {
  return async () => { throw new Error(`test_runtime_operation_not_configured:${operation}`); };
}
