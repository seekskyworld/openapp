import { readFile } from "node:fs/promises";

export interface AdapterCatalogEntry {
  id: string;
  module: string;
  version: string;
  environment: Record<string, string>;
}
export interface AdapterCatalog { schemaVersion: 1; plugins: AdapterCatalogEntry[] }

/** Deployment-owned configuration. Never accept a catalog from an HTTP request. */
export function parseAdapterCatalog(value: unknown): AdapterCatalog {
  const catalog = value as AdapterCatalog;
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.plugins)
    || !catalog.plugins.length || catalog.plugins.length > 100) throw new Error("adapter_catalog_invalid");
  const ids = new Set<string>();
  const modules = new Set<string>();
  const plugins = catalog.plugins.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id)
      || typeof entry.module !== "string" || !entry.module.trim()
      || typeof entry.version !== "string" || !entry.version.trim()) throw new Error("adapter_catalog_entry_invalid");
    if (ids.has(entry.id) || modules.has(entry.module.trim())) throw new Error("adapter_catalog_duplicate");
    ids.add(entry.id); modules.add(entry.module.trim());
    const environment = entry.environment ?? {};
    if (!environment || typeof environment !== "object" || Array.isArray(environment)
      || Object.entries(environment).some(([key, val]) => !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof val !== "string")) {
      throw new Error("adapter_catalog_environment_invalid");
    }
    return { id: entry.id, module: entry.module.trim(), version: entry.version, environment: { ...environment } };
  });
  return { schemaVersion: 1, plugins };
}

export async function readAdapterCatalog(path: string): Promise<AdapterCatalog> {
  return parseAdapterCatalog(JSON.parse(await readFile(path, "utf8")));
}
