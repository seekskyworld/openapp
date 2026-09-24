import { createHash } from "node:crypto";
import type { AuthLoginResult, AuthProvider, AuthLoginInput } from "../auth/types.js";

export class MockAuthProvider implements AuthProvider {
  readonly id = "mock" as const;

  async sendEmailCode(_email: string): Promise<void> {
    return;
  }

  async login(input: AuthLoginInput): Promise<AuthLoginResult> {
    return {
      identity: {
        provider: this.id,
        subject: `mock-${createHash("sha256").update(input.email).digest("hex").slice(0, 24)}`,
        email: input.email,
        isNewUser: false,
      },
    };
  }
}
