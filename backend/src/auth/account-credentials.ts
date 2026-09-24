import type { AccountAuthState, AuthenticatedUser, AuthMethod, User } from "../models.js";
import { isManagementRole } from "../user-role-policy.js";
import { hashLocalPassword, validateLocalPassword, verifyLocalPassword } from "./local-password.js";
import { AuthProviderRegistry } from "./provider-registry.js";

export interface AccountCredentialRepository {
  findUserByIdentity(provider: string, subject: string): Promise<User | null>;
  getLocalPasswordHash(userId: string): Promise<string | null>;
  getAccountAuthState(userId: string): Promise<AccountAuthState>;
  createLocalPasswordHash(userId: string, passwordHash: string): Promise<boolean>;
  replaceLocalPasswordHash(userId: string, expectedHash: string, passwordHash: string): Promise<boolean>;
}

export class AccountCredentialError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class AccountCredentials {
  constructor(
    private readonly repository: AccountCredentialRepository,
    private readonly externalAuth: AuthProviderRegistry,
  ) {}

  async project(user: User, authMethod: AuthMethod): Promise<AuthenticatedUser> {
    const state = await this.repository.getAccountAuthState(user.id);
    return {
      ...user,
      authMethod,
      passwordSetupRequired: !state.hasLocalCredential,
      linkedProviders: state.externalProviders,
    };
  }

  async setup(user: AuthenticatedUser, newPasswordInput: unknown): Promise<User> {
    if (user.authMethod === "local" || user.authMethod === "cli") {
      throw new AccountCredentialError("password_setup_not_allowed");
    }
    const state = await this.repository.getAccountAuthState(user.id);
    if (state.hasLocalCredential) throw new AccountCredentialError("password_already_set");
    if (!user.authMethod || !state.externalProviders.includes(user.authMethod)) {
      throw new AccountCredentialError("external_identity_not_linked");
    }
    const passwordHash = await hashLocalPassword(readPassword(newPasswordInput));
    if (!(await this.repository.createLocalPasswordHash(user.id, passwordHash))) {
      throw new AccountCredentialError("password_already_set");
    }
    return user;
  }

  async changeWithCurrentPassword(
    user: AuthenticatedUser,
    currentPassword: unknown,
    newPasswordInput: unknown,
  ): Promise<User> {
    const currentHash = await this.repository.getLocalPasswordHash(user.id);
    const current = typeof currentPassword === "string" ? currentPassword : "";
    if (!currentHash || !(await verifyLocalPassword(current, currentHash))) {
      throw new AccountCredentialError("invalid_current_password");
    }
    const passwordHash = await hashLocalPassword(readPassword(newPasswordInput));
    if (!(await this.repository.replaceLocalPasswordHash(user.id, currentHash, passwordHash))) {
      throw new AccountCredentialError("credential_update_conflict");
    }
    return user;
  }

  async sendExternalCode(user: AuthenticatedUser, providerId: string): Promise<void> {
    await this.assertExternalChangeAllowed(user, providerId);
    await this.externalAuth.sendEmailCode(providerId, user.email);
  }

  async changeWithExternal(
    user: AuthenticatedUser,
    providerId: string,
    codeInput: unknown,
    newPasswordInput: unknown,
  ): Promise<User> {
    const state = await this.assertExternalChangeAllowed(user, providerId);
    const code = typeof codeInput === "string" ? codeInput.trim() : "";
    if (!code || code.length > 256) throw new AccountCredentialError("verification_code_required");
    const identity = await this.externalAuth.verifyIdentityWithEphemeralLogin(providerId, { email: user.email, code });
    const identityUser = await this.repository.findUserByIdentity(identity.provider, identity.subject);
    if (!identityUser || identityUser.id !== user.id) throw new AccountCredentialError("external_identity_mismatch");
    const currentHash = state.hasLocalCredential ? await this.repository.getLocalPasswordHash(user.id) : null;
    if (state.hasLocalCredential && !currentHash) throw new AccountCredentialError("credential_update_conflict");
    const passwordHash = await hashLocalPassword(readPassword(newPasswordInput));
    const updated = currentHash
      ? await this.repository.replaceLocalPasswordHash(user.id, currentHash, passwordHash)
      : await this.repository.createLocalPasswordHash(user.id, passwordHash);
    if (!updated) throw new AccountCredentialError("credential_update_conflict");
    return user;
  }

  private async assertExternalChangeAllowed(user: AuthenticatedUser, providerId: string): Promise<AccountAuthState> {
    if (isManagementRole(user.role)) throw new AccountCredentialError("external_password_change_not_allowed");
    const state = await this.repository.getAccountAuthState(user.id);
    if (!state.externalProviders.includes(providerId)) {
      throw new AccountCredentialError("external_identity_not_linked");
    }
    return state;
  }
}

function readPassword(value: unknown): string {
  try {
    return validateLocalPassword(value);
  } catch (error) {
    throw new AccountCredentialError(error instanceof Error ? error.message : "password_required");
  }
}
