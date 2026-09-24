import type { User } from "../models.js";
import { MemoryPersistence } from "../persistence/memory.js";

/** Memory adapter with an explicit fixture-only bootstrap seam. */
export class TestMemoryPersistence extends MemoryPersistence {
  seedManagementUser(email: string, passwordHash: string, role: "admin" | "super_admin"): User {
    return this.seedLocalManagementUserForTests(email, passwordHash, role);
  }
}
