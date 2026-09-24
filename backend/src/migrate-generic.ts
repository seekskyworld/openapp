/**
 * OpenApp 通用数据库迁移入口。
 *
 * 这里只初始化平台 schema，不加载 App 插件、旧 Provider 或产品 seed；需要
 * 迁移旧应用数据时必须显式调用 `migrate:legacy`，避免通用部署误用
 * 历史组合的默认值。
 */
import { loadGenericConfig } from "./config-core.js";
import { createConfiguredPersistence } from "./persistence/factory.js";

const persistence = createConfiguredPersistence(loadGenericConfig());
try {
  await persistence.initialize({ strategyDefinitions: [] });
  console.log("openapp database ready");
} finally {
  await persistence.close?.();
}
