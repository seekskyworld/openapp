/** 清理失败必须可见，同时保留操作本身的失败，避免 finally 覆盖原始诊断。 */
export async function withRuntimeCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result!: T;
  let failed = false;
  let primary: unknown;
  try {
    result = await operation();
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (failed)
      throw new AggregateError(
        [primary, error],
        error instanceof Error ? error.message : "runtime_cleanup_failed",
        { cause: primary },
      );
    throw error;
  }
  if (failed) throw primary;
  return result;
}
