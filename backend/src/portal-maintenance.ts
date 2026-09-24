export type PortalMaintenanceTask = "upgrade-rollout-worker" | "idle-sweep";

export interface PortalMaintenanceCoordinatorOptions {
  runUpgradeRolloutWorker(): Promise<void>;
  sweepIdleContainers(): Promise<void>;
  onError(task: PortalMaintenanceTask, error: unknown): void;
}

/**
 * Portal 周期任务共享实例维护租约，必须在单一队列中协调。升级任务优先，
 * 否则同相位启动的 idle sweep 会反复抢先取得实例租约，让到期 rollout 饥饿。
 */
export class PortalMaintenanceCoordinator {
  readonly #runUpgradeRolloutWorker: () => Promise<void>;
  readonly #sweepIdleContainers: () => Promise<void>;
  readonly #onError: (task: PortalMaintenanceTask, error: unknown) => void;
  #upgradeRequested = false;
  #sweepRequested = false;
  #draining: Promise<void> | undefined;
  #stopped = false;

  constructor(options: PortalMaintenanceCoordinatorOptions) {
    this.#runUpgradeRolloutWorker = options.runUpgradeRolloutWorker;
    this.#sweepIdleContainers = options.sweepIdleContainers;
    this.#onError = options.onError;
  }

  requestUpgradeRun(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#upgradeRequested = true;
    return this.#ensureDrain();
  }

  requestMaintenanceCycle(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#upgradeRequested = true;
    this.#sweepRequested = true;
    return this.#ensureDrain();
  }

  #ensureDrain(): Promise<void> {
    if (this.#draining) return this.#draining;
    const draining = this.#drain().finally(() => {
      if (this.#draining === draining) this.#draining = undefined;
    });
    this.#draining = draining;
    return draining;
  }

  /** 停机时不再发起下一轮任务，等待已开始的维护操作释放租约。 */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#upgradeRequested = false;
    this.#sweepRequested = false;
    await this.#draining;
  }

  async #drain(): Promise<void> {
    while (this.#upgradeRequested || this.#sweepRequested) {
      if (this.#upgradeRequested) {
        this.#upgradeRequested = false;
        await this.#runTask("upgrade-rollout-worker", this.#runUpgradeRolloutWorker);
        continue;
      }
      this.#sweepRequested = false;
      await this.#runTask("idle-sweep", this.#sweepIdleContainers);
    }
  }

  async #runTask(task: PortalMaintenanceTask, operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.#onError(task, error);
    }
  }
}
