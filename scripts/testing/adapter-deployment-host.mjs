/** 版本化部署测试端口；不进入服务或部署包，路径由调用方显式选择。 */
import {fileURLToPath} from 'node:url';
export const apiVersion = 1;
export const coreRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
export {validateAdapterManifest, adapterManifestIdentity} from '../validate-adapter-manifest.mjs';
export {validateAdapterLegacyRelease} from '../validate-adapter-legacy-release.mjs';
