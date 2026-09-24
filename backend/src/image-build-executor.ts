import type { AppVersion } from "./models.js";
import { ImageBuildError, ImageBuildManager, type ImageBuildRecord } from "./image-builds.js";
import {
  ImageBuildExecutionError,
  type BuildStrategyRegistry,
  type StandaloneBuildSource,
  type StrategyPackageInspection,
  type StrategyPackageInspectionInput,
  type StrategyBuildInput,
  type StrategyBuildOutput,
} from "./build-strategies.js";

export interface ImageBuildExecutorOptions {
  manager: ImageBuildManager;
  releaseRoot: string;
  resolveVersion(id: string): Promise<AppVersion | null>;
}

export interface ExecuteImageBuildOptions {
  signal?: AbortSignal;
  report?: (progress: number, stage: string) => Promise<void>;
  commitPoint?: () => Promise<void>;
  standaloneSource?: StandaloneBuildSource;
}

export interface ExecutedImageBuild {
  record: ImageBuildRecord;
}

/** Coordinates a durable build record with one code-owned strategy adapter. */
export class ImageBuildExecutor {
  readonly #manager: ImageBuildManager;
  readonly #registry: BuildStrategyRegistry;
  readonly #releaseRoot: string;
  readonly #resolveVersion: (id: string) => Promise<AppVersion | null>;

  constructor(options: ImageBuildExecutorOptions) {
    this.#manager = options.manager;
    this.#registry = options.manager.strategyRegistry;
    this.#releaseRoot = options.releaseRoot;
    this.#resolveVersion = options.resolveVersion;
  }

  inspectPackages(
    strategyId: string,
    revision: number,
    input: StrategyPackageInspectionInput,
  ): Promise<StrategyPackageInspection> {
    return this.#registry.inspectPackages(strategyId, revision, input);
  }

  async execute(id: string, options: ExecuteImageBuildOptions = {}): Promise<ExecutedImageBuild> {
    const initial = await this.#manager.getBuild(id);
    if (initial.build.status === "succeeded") {
      return { record: initial };
    }
    if (initial.build.status !== "queued") {
      throw new ImageBuildError(`invalid_image_build_transition:${initial.build.status}:building`, 409);
    }
    const signal = options.signal ?? new AbortController().signal;
    const report = options.report ?? (async () => undefined);
    const commitPoint = options.commitPoint ?? (async () => undefined);
    const build = await this.#manager.startBuild(id);
    let output: StrategyBuildOutput | null = null;
    try {
      const version = build.sourceAppVersionId
        ? await this.#resolveVersion(build.sourceAppVersionId)
        : null;
      if (build.sourceAppVersionId && !version) {
        throw new ImageBuildError("app_version_not_found", 404);
      }
      if (version && (version.status === "active" || version.status === "legacy")) {
        throw new ImageBuildError("app_version_immutable", 409);
      }
      if (signal.aborted) throw new ImageBuildExecutionError("image_build_cancelled");
      const strategy = this.#registry.resolve(build.strategySnapshot.id, build.strategySnapshot.revision);
      const input: StrategyBuildInput = {
        build,
        appVersion: version,
        standaloneSource: options.standaloneSource,
        releaseRoot: this.#releaseRoot,
        signal,
        report,
      };
      output = await strategy.execute(input);
      if (signal.aborted) throw new ImageBuildExecutionError("image_build_cancelled");
      // 构建域只登记不可变产物；版本绑定是之后的显式目录操作。
      await commitPoint();
      const completedRecord = await this.#manager.completeBuild(id, output);
      return { record: completedRecord };
    } catch (error) {
      if (signal.aborted || error instanceof ImageBuildExecutionError && error.code === "image_build_cancelled") {
        await this.#manager.cancelBuild(id).catch(() => undefined);
      } else {
        await this.#manager.failBuild(id, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      }
      if (output?.cleanup) {
        const latest = await this.#manager.getBuild(id).catch(() => null);
        if (latest && latest.build.status !== "succeeded") await output.cleanup();
      }
      throw error;
    }
  }

}
