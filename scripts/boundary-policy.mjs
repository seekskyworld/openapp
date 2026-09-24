/** 显式加载外部发布检查策略；Core 不定义产品名，缺失或非法策略必须报错。 */
import { readFileSync } from 'node:fs';

export function loadBoundaryPolicy(path = process.env.OPENAPP_BOUNDARY_POLICY) {
  if (!path) return Object.freeze({});
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  if (policy?.schemaVersion !== 1) throw new Error('boundary policy schemaVersion must be 1');
  const pathFields = ['backendPaths', 'runtimePaths', 'frontendAssets', 'deploymentPaths'];
  const fields = [...pathFields, 'frontendChunkPrefixes', 'markers', 'repositoryNames'];
  for (const key of Object.keys(policy)) {
    if (key !== 'schemaVersion' && !fields.includes(key)) throw new Error(`unknown boundary policy field: ${key}`);
  }
  for (const key of fields) {
    if (policy[key] === undefined) continue;
    if (!Array.isArray(policy[key]) || policy[key].some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error(`boundary policy requires nonempty strings: ${key}`);
    }
    if (pathFields.includes(key) && policy[key].some(value => !/^[a-zA-Z0-9._/-]+$/.test(value)
      || value.startsWith('/') || value.split('/').some(segment => !segment || segment === '..' || segment === '.'))) {
      throw new Error(`boundary policy path is unsafe: ${key}`);
    }
  }
  return Object.freeze(policy);
}

export const boundaryPolicy = loadBoundaryPolicy();
// 没有外部策略时只做 Core 自身的结构检查，不猜测任何产品词表。
export const forbiddenMarkerPattern = new RegExp((boundaryPolicy.markers ?? []).map(value => `(?:${value})`).join('|') || '(?!)', 'iu');
