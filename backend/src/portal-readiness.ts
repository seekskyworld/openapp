/** 就绪检查与存活分离；数据库超时不会拖住健康请求，也不启动重复的探测。 */
export function createReadinessProbe(check: () => Promise<void>, timeoutMs = 2_000) {
  let pending: Promise<boolean> | undefined;
  return async (): Promise<boolean> => {
    if (!pending) {
      const operation = Promise.resolve()
        .then(check)
        .then(
          () => true,
          () => false,
        );
      pending = operation;
      void operation.finally(() => {
        if (pending === operation) pending = undefined;
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
