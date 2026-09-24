/** 旧命令名保留；迁移始终由外部 Adapter 声明合同，缺失时停止执行。 */
import { migrateLegacy } from "./migrate-legacy.js";

await migrateLegacy({ requireExternalAdapter: true });
