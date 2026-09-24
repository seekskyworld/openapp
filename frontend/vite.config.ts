import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { COMPATIBILITY_ARTIFACT_POLICY } from '../scripts/compatibility-manifest.mjs';

function isLegacyFrontendArtifact(fileName: string): boolean {
  const normalized = fileName.replaceAll('\\', '/');
  return COMPATIBILITY_ARTIFACT_POLICY.frontendLegacyAssets.includes(normalized)
    || COMPATIBILITY_ARTIFACT_POLICY.frontendLegacyChunkPrefixes.some((prefix) => (
      normalized.startsWith(`assets/${prefix}`)
    ));
}

/**
 * Rollup 会为已被编译期分支折叠的动态 import 保留孤儿 chunk；generic
 * 发布不应携带这些旧实现，因此在最终 bundle 生成阶段按兼容清单裁剪。
 */
function pruneGenericCompatibilityChunks(enabled: boolean) {
  return {
    name: 'openapp-generic-compatibility-boundary',
    generateBundle(_options: unknown, bundle: Record<string, { fileName: string }>) {
      if (!enabled) return;
      for (const [fileName, output] of Object.entries(bundle)) {
        if (isLegacyFrontendArtifact(output.fileName || fileName)) delete bundle[fileName];
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'VITE_');
  const buildTarget = mode === 'generic' ? 'generic' : 'legacy';
  return {
    plugins: [react(), pruneGenericCompatibilityChunks(buildTarget === 'generic')],
    define: {
      __OPENAPP_FRONTEND_BUILD_TARGET__: JSON.stringify(buildTarget),
    },
    server: { port: 4174, proxy: { '/api': env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:4310' } },
    build: { outDir: 'dist', sourcemap: buildTarget === 'legacy' },
  };
});
