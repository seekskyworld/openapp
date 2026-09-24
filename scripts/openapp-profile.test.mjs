import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveEnvironment, publicUrl } from './openapp-profile.mjs';

const root = '/workspace/openapp';

test('dev local derives host runtime and Vite proxy settings', () => {
  const profile = {
    selection: { runtime: 'orbstack' },
    channel: { id: 'dev', frontend: 'vite' },
    deployment: { id: 'local', runtimeEndpointMode: 'loopback', backendHost: '127.0.0.1', backendPort: 14313, frontendHost: '127.0.0.1', frontendPort: 4174 },
  };
  const env = deriveEnvironment(root, profile, { DATABASE_URL: 'postgres://example' });
  assert.equal(env.CONTAINER_RUNTIME_ENDPOINT_MODE, 'loopback');
  assert.equal(env.CONTAINER_RUNTIME, 'orbstack');
  assert.equal(env.VITE_API_PROXY_TARGET, 'http://127.0.0.1:14313');
  assert.equal(env.PORTAL_ALLOWED_ORIGINS, 'http://127.0.0.1:4174');
  assert.equal(publicUrl(profile), 'http://127.0.0.1:4174/');
});

test('stable container derives private-network runtime settings', () => {
  const profile = {
    selection: { runtime: 'docker' },
    channel: { id: 'stable', frontend: 'static', containerImage: 'openapp-portal:stable' },
    deployment: { id: 'container', runtimeEndpointMode: 'network', portalContainer: 'openapp-portal', portalPort: 14313 },
  };
  const env = deriveEnvironment(root, profile, {});
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.CONTAINER_RUNTIME_ENDPOINT_MODE, 'network');
  assert.equal(env.CONTAINER_RUNTIME, 'docker');
  assert.equal(env.OPENAPP_PORTAL_CONTAINER, 'openapp-portal');
  assert.deepEqual(Object.keys(env).filter(key => key.endsWith("_PORTAL_CONTAINER")), ["OPENAPP_PORTAL_CONTAINER"]);
  assert.equal(env.PORTAL_IMAGE, 'openapp-portal:stable');
  assert.equal(publicUrl(profile), 'http://127.0.0.1:14313/');
});
