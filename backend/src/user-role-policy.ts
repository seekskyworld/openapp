import { UserRoleUpdateError, type UserRole } from "./models.js";

export function isManagementRole(role: UserRole): role is "admin" | "super_admin" {
  return role === "admin" || role === "super_admin";
}

export function assertCanCreateManagedUser(
  actorRole: UserRole | null | undefined,
  requestedRole: UserRole,
): asserts actorRole is "admin" | "super_admin" {
  if (!actorRole || !isManagementRole(actorRole)) {
    throw new UserRoleUpdateError("target_role_not_manageable");
  }
  if (requestedRole !== "user" && actorRole !== "super_admin") {
    throw new UserRoleUpdateError("super_admin_required");
  }
}

export function assertCanGovernUserRoles(actorRole: UserRole | null | undefined): asserts actorRole is "super_admin" {
  if (actorRole !== "super_admin") throw new UserRoleUpdateError("super_admin_required");
}
