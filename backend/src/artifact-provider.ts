import { ContainerArtifactValidationError, type ContainerRuntime } from "./runtime.js";

export type ArtifactFailureKind = "invalid" | "unsupported" | "unavailable";
export type ArtifactOperation = "list" | "resolve" | "validate" | "validate_built" | "pull" | "load" | "remove";

export class ArtifactOperationError extends Error {
  readonly failureClass: "transient" | "permanent";
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    readonly artifactFailureKind: ArtifactFailureKind,
    readonly operation: ArtifactOperation,
    readonly status: 409 | 501 | 503,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ArtifactOperationError";
    this.failureClass = artifactFailureKind === "unavailable" ? "transient" : "permanent";
    this.retryable = this.failureClass === "transient";
  }
}

export interface OciImageInventoryItem {
  reference: string;
  id?: string;
  size?: string;
}

/** OCI 制品管理与 Workspace 执行生命周期分离，构建和清理只能取得这组窄接口。 */
export interface OciArtifactManagementPort {
  listImages(): Promise<OciImageInventoryItem[]>;
  resolveImage(reference: string): Promise<string | null>;
  validateImage(reference: string, executionContract: string): Promise<void>;
  validateBuiltImage(reference: string, executionContract: string): Promise<void>;
  removeImageIfCurrent(reference: string, expectedImageId: string): Promise<boolean>;
  pullImage(reference: string): Promise<void>;
  loadImage(archivePath: string, reference: string): Promise<void>;
}

/**
 * Docker 的镜像 API 仍由经过验证的 Runtime 实现，这个适配器只隔离能力边界并归一化错误，
 * 不让 Catalog、Build 或 Cleanup 取得 Environment 生命周期接口。
 */
export class DockerArtifactAdapter implements OciArtifactManagementPort {
  readonly #runtime: ContainerRuntime;

  constructor(runtime: ContainerRuntime) {
    this.#runtime = runtime;
  }

  listImages(): Promise<OciImageInventoryItem[]> {
    return this.#invoke("list", "runtime_image_listing_unavailable", this.#runtime.listImages?.bind(this.#runtime));
  }

  async resolveImage(reference: string): Promise<string | null> {
    if (this.#runtime.resolveImage) {
      return this.#invoke(
        "resolve",
        "runtime_image_resolution_unavailable",
        () => this.#runtime.resolveImage!(reference),
      );
    }
    const image = (await this.listImages()).find((candidate) => (
      candidate.reference === reference || candidate.id === reference
    ));
    // 可变 tag 只有在 Provider 返回稳定 ID 时才能进入 Revision 快照。
    return image?.id ?? null;
  }

  validateImage(reference: string, executionContract: string): Promise<void> {
    return this.#invokeValidation(
      "validate",
      "runtime_image_validation_unavailable",
      this.#runtime.validateImage
        ? () => this.#runtime.validateImage!(reference, executionContract)
        : undefined,
    );
  }

  validateBuiltImage(reference: string, executionContract: string): Promise<void> {
    return this.#invokeValidation(
      "validate_built",
      "runtime_built_image_validation_unavailable",
      this.#runtime.validateBuiltImage
        ? () => this.#runtime.validateBuiltImage!(reference, executionContract)
        : undefined,
    );
  }

  removeImageIfCurrent(reference: string, expectedImageId: string): Promise<boolean> {
    return this.#invoke(
      "remove",
      "runtime_image_cleanup_unavailable",
      this.#runtime.removeImageIfCurrent
        ? () => this.#runtime.removeImageIfCurrent!(reference, expectedImageId)
        : undefined,
    );
  }

  pullImage(reference: string): Promise<void> {
    return this.#invoke(
      "pull",
      "runtime_image_pull_unavailable",
      this.#runtime.pullImage ? () => this.#runtime.pullImage!(reference) : undefined,
    );
  }

  loadImage(archivePath: string, reference: string): Promise<void> {
    return this.#invoke(
      "load",
      "runtime_image_load_unavailable",
      this.#runtime.loadImage ? () => this.#runtime.loadImage!(archivePath, reference) : undefined,
    );
  }

  async #invoke<T>(
    operation: ArtifactOperation,
    unsupportedCode: string,
    action: (() => Promise<T>) | undefined,
  ): Promise<T> {
    if (!action) throw new ArtifactOperationError(unsupportedCode, "unsupported", operation, 501);
    try {
      return await action();
    } catch (error) {
      if (error instanceof ArtifactOperationError) throw error;
      throw new ArtifactOperationError(
        `${unsupportedCode.replace(/_unavailable$/u, "")}_failed`,
        "unavailable",
        operation,
        503,
        { cause: error },
      );
    }
  }

  async #invokeValidation(
    operation: Extract<ArtifactOperation, "validate" | "validate_built">,
    unsupportedCode: string,
    action: (() => Promise<void>) | undefined,
  ): Promise<void> {
    if (!action) throw new ArtifactOperationError(unsupportedCode, "unsupported", operation, 501);
    try {
      await action();
    } catch (error) {
      if (error instanceof ArtifactOperationError) throw error;
      if (error instanceof ContainerArtifactValidationError) {
        throw new ArtifactOperationError(
          error.code,
          error.failure,
          operation,
          error.failure === "unsupported" ? 501 : 409,
          { cause: error },
        );
      }
      throw new ArtifactOperationError(
        `${unsupportedCode.replace(/_validation_unavailable$/u, "")}_validation_unavailable`,
        "unavailable",
        operation,
        503,
        { cause: error },
      );
    }
  }
}
