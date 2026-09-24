import type { BuildPackageRequirement } from "./build.js";

/** 宿主与插件共用的包槽位边界，避免清单通过后才在启动时失败。 */
export const MAX_BUILD_PACKAGE_BYTES = 512 * 1024 * 1024;
export function validateBuildPackageRequirements(value: unknown): BuildPackageRequirement[] {
  return validateRequirements(value, false);
}

/** 历史表单允许区分大小写的字段；仍禁止路径、重复字段与超限声明。 */
export function validateUploadRequirements(value: unknown): BuildPackageRequirement[] {
  return validateRequirements(value, true);
}

function validateRequirements(value: unknown, preserveCase: boolean): BuildPackageRequirement[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new Error("build_strategy_packages_required");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid_build_package_requirement");
    const key = typeof item.key === "string" ? item.key.trim() : "";
    const pattern = preserveCase ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u : /^[a-z0-9][a-z0-9._-]{0,63}$/u;
    if (!pattern.test(key) || item.key !== key || key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("invalid_build_package_key");
    if (seen.has(key)) throw new Error("duplicate_build_package_key");
    seen.add(key);
    if (typeof item.required !== "boolean") throw new Error("invalid_build_package_requirement");
    if (!Array.isArray(item.acceptedExtensions) || !item.acceptedExtensions.length || item.acceptedExtensions.length > 16) throw new Error("invalid_build_package_extensions");
    const acceptedExtensions = item.acceptedExtensions.map((extension: unknown) => {
      if (typeof extension !== "string" || !/^\.[a-z0-9][a-z0-9.-]{0,31}$/u.test(extension.trim().toLowerCase())) throw new Error("invalid_build_package_extensions");
      return extension.trim().toLowerCase();
    });
    const maxBytes = item.maxBytes ?? MAX_BUILD_PACKAGE_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BUILD_PACKAGE_BYTES) throw new Error("invalid_build_package_max_bytes");
    return { key, required: item.required, acceptedExtensions: [...new Set<string>(acceptedExtensions)], maxBytes };
  });
}
