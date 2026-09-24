import assert from "node:assert/strict";
import test from "node:test";

import {
  authProviderAcceptanceEnvironment,
  dockerAcceptanceEnvironment,
  isolatedAcceptanceEnvironment,
  postgresAcceptanceEnvironment,
} from "./openapp-acceptance-environment.mjs";

test("acceptance unit gates cannot inherit deployment or integration configuration", () => {
  const isolated = isolatedAcceptanceEnvironment({
    PATH: "/usr/bin",
    TMPDIR: "/tmp/acceptance",
    NODE_ENV: "production",
    AUTH_PROVIDER: "sample-provider",
    DATABASE_URL: "postgres://production.example.test/openapp",
    DOCKER_CONTEXT: "remote-production",
    DOCKER_HOST: "tcp://production.example.test:2376",
    OPENAPP_RELEASE_DIR: "/srv/openapp/releases",
    SAMPLE_CONTAINER_IMAGE: "registry.example.test/sample:production",
    PORTAL_PUBLIC_BASE_URL: "https://portal.example.test",
    POSTGRES_PASSWORD: "secret",
    TARGET_PLATFORM: "linux/amd64",
  });

  assert.deepEqual(isolated, {
    PATH: "/usr/bin",
    TMPDIR: "/tmp/acceptance",
  });
});

test("PostgreSQL acceptance requires an explicit disposable test database", () => {
  assert.throws(
    () => postgresAcceptanceEnvironment({
      DATABASE_URL: "postgres://production.example.test/openapp",
    }),
    /POSTGRES_TEST_URL is required/u,
  );
  assert.deepEqual(postgresAcceptanceEnvironment({
    DATABASE_URL: "postgres://production.example.test/openapp",
    POSTGRES_TEST_URL: "  postgres://localhost/openapp_acceptance  ",
  }), {
    POSTGRES_TEST_URL: "postgres://localhost/openapp_acceptance",
  });
});

test("Docker endpoint selection is restored only for explicit Docker gates", () => {
  assert.deepEqual(dockerAcceptanceEnvironment({
    DOCKER_CONTEXT: " acceptance-engine ",
    DOCKER_HOST: " tcp://acceptance.example.test:2376 ",
  }), {
    DOCKER_CONTEXT: "acceptance-engine",
    DOCKER_HOST: "tcp://acceptance.example.test:2376",
  });
  assert.deepEqual(dockerAcceptanceEnvironment({}), {});
});

test("Docker gates forward generic auth provider aliases by default", () => {
  assert.deepEqual(authProviderAcceptanceEnvironment({
    OPENAPP_AUTH_PROVIDER_BASE_URL: " https://identity.example.test ",
    AUTH_PROVIDER_BASE_URL: "https://identity-alias.example.test",
    OPENAPP_ADMIN_CLI_TOKEN: "must-not-forward",
  }), {
    OPENAPP_AUTH_PROVIDER_BASE_URL: "https://identity.example.test",
    AUTH_PROVIDER_BASE_URL: "https://identity-alias.example.test",
  });
  assert.deepEqual(authProviderAcceptanceEnvironment({
    SAMPLE_PROVIDER_URL: "https://legacy.example.test",
  }, { providerEnvironmentNames: ['SAMPLE_PROVIDER_URL'] }), {
    SAMPLE_PROVIDER_URL: "https://legacy.example.test",
  });
  assert.deepEqual(authProviderAcceptanceEnvironment({}), {});
});
