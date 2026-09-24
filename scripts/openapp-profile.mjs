import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CHANNELS = new Set(['dev', 'stable']);
const DEPLOYMENTS = new Set(['local', 'container']);
const RUNTIMES = new Set(['docker', 'orbstack']);

export async function loadProfile(root, processEnv = process.env) {
  const selection = await readJson(resolve(root, 'config/openapp.config.json'));
  if (!CHANNELS.has(selection.channel)) throw new Error('channel must be dev or stable');
  if (!DEPLOYMENTS.has(selection.deployment)) throw new Error('deployment must be local or container');
  if (!RUNTIMES.has(selection.runtime)) throw new Error('runtime must be docker or orbstack');

  const channel = await readJson(resolve(root, `config/channels/${selection.channel}.json`));
  const deployment = await readJson(resolve(root, `config/deployments/${selection.deployment}.json`));
  if (channel.id !== selection.channel) throw new Error('selected channel profile id does not match');
  if (deployment.id !== selection.deployment) throw new Error('selected deployment profile id does not match');

  const fileEnv = await readEnvFile(resolve(root, '.env.local'));
  const env = { ...fileEnv, ...processEnv };
  const profile = { selection, channel, deployment };
  return { profile, env: deriveEnvironment(root, profile, env) };
}

export function deriveEnvironment(root, profile, sourceEnv = {}) {
  const { channel, deployment } = profile;
  const env = { ...sourceEnv };
  env.NODE_ENV = channel.id === 'stable' ? 'production' : 'development';
  env.CONTAINER_RUNTIME = profile.selection.runtime;
  env.CONTAINER_RUNTIME_ENDPOINT_MODE = deployment.runtimeEndpointMode;

  if (deployment.id === 'local') {
    const backendOrigin = `http://${deployment.backendHost}:${deployment.backendPort}`;
    const frontendOrigin = channel.frontend === 'vite'
      ? `http://${deployment.frontendHost}:${deployment.frontendPort}`
      : backendOrigin;
    env.HOST = deployment.backendHost;
    env.PORT = String(deployment.backendPort);
    env.PORTAL_PUBLIC_BASE_URL = backendOrigin;
    env.PORTAL_ALLOWED_ORIGINS = frontendOrigin;
    env.OPENAPP_BRIDGE_ALLOWED_ORIGINS = frontendOrigin;
    env.VITE_API_PROXY_TARGET = backendOrigin;
    env.PORTAL_STATIC_DIR = resolve(root, 'frontend/dist');
    delete env.OPENAPP_PORTAL_CONTAINER;
  } else {
    const origin = env.PUBLIC_ORIGIN || `http://127.0.0.1:${deployment.portalPort}`;
    env.PORTAL_PORT = String(deployment.portalPort);
    env.PORTAL_PUBLIC_BASE_URL = env.PORTAL_PUBLIC_BASE_URL || origin;
    env.PUBLIC_ORIGIN = origin;
    env.OPENAPP_PORTAL_CONTAINER = env.OPENAPP_PORTAL_CONTAINER || deployment.portalContainer;
    env.PORTAL_IMAGE = env.PORTAL_IMAGE || channel.containerImage;
  }
  return env;
}

export function publicUrl(profile) {
  const { channel, deployment } = profile;
  if (deployment.id === 'container') return `http://127.0.0.1:${deployment.portalPort}/`;
  const port = channel.frontend === 'vite' ? deployment.frontendPort : deployment.backendPort;
  const host = channel.frontend === 'vite' ? deployment.frontendHost : deployment.backendHost;
  return `http://${host}:${port}/`;
}

async function readJson(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value;
}

async function readEnvFile(path) {
  let content;
  try { content = await readFile(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
  const env = {};
  for (const [index, rawLine] of content.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`invalid .env.local line ${index + 1}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error(`invalid .env.local key on line ${index + 1}`);
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
