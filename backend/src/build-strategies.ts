/** Core 只注册并调用插件提供的构建能力，不内置应用构建配方。 */
import { ImageBuildExecutionError, type BuildStrategyAdapter, type StrategyPackageInspectionInput, type StrategyPackageInspection, type InspectedStrategyPackage } from "@openapp/contracts";
export { ImageBuildExecutionError } from "@openapp/contracts";
export type { StrategyBuildInput, StrategyBuildOutput, StandaloneBuildSource, BuildStrategyAdapter, StrategyPackageInspectionInput, StrategyPackageInspection, InspectedStrategyPackage, BuildCommandRunner, BuildCommandOptions } from "@openapp/contracts";

export class BuildStrategyRegistry {
  readonly #adapters: ReadonlyMap<string, BuildStrategyAdapter>;

  constructor(adapters: readonly BuildStrategyAdapter[]) {
    const values = new Map<string, BuildStrategyAdapter>();
    for (const adapter of adapters) {
      const id = adapter.id.trim().toLowerCase();
      const key = adapterKey(id, adapter.revision);
      if (!id || values.has(key)) throw new ImageBuildExecutionError("build_strategy_adapter_conflict");
      values.set(key, adapter);
    }
    this.#adapters = values;
  }

  supports(id: string, revision: number): boolean {
    const normalizedId = typeof id === "string" ? id.trim().toLowerCase() : "";
    if (!normalizedId || !Number.isSafeInteger(revision) || revision < 1) return false;
    return this.#adapters.has(`${normalizedId}@${revision}`);
  }

  /** 判断某个策略是否有任意已注册版本，用于区分版本漂移和未知策略。 */
  has(id: string): boolean {
    const normalizedId = typeof id === "string" ? id.trim().toLowerCase() : "";
    if (!normalizedId) return false;
    return [...this.#adapters.keys()].some((key) => key.startsWith(`${normalizedId}@`));
  }

  resolve(id: string, revision: number): BuildStrategyAdapter {
    const adapter = this.#adapters.get(adapterKey(id.trim().toLowerCase(), revision));
    if (!adapter) throw new ImageBuildExecutionError("build_strategy_adapter_not_found");
    return adapter;
  }

  async inspectPackages(
    id: string,
    revision: number,
    input: StrategyPackageInspectionInput,
  ): Promise<StrategyPackageInspection> {
    const adapter = this.resolve(id, revision);
    if (!adapter.inspectPackages) {
      throw new ImageBuildExecutionError("build_strategy_package_inspection_unavailable");
    }
    return adapter.inspectPackages(input);
  }

  async inspectPackage(
    id: string,
    revision: number,
    key: string,
    sourcePath: string,
  ): Promise<InspectedStrategyPackage> {
    const adapter = this.resolve(id, revision);
    if (!adapter.inspectPackage) {
      throw new ImageBuildExecutionError("build_strategy_package_inspection_unavailable");
    }
    return adapter.inspectPackage(key, sourcePath);
  }
}

function adapterKey(id: string, revision: number): string {
  if (!id || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ImageBuildExecutionError("build_strategy_adapter_invalid");
  }
  return `${id}@${revision}`;
}
