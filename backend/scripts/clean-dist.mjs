#!/usr/bin/env node

/**
 * 只清理当前包的 TypeScript 输出目录，避免 generic 构建沿用上一轮全量
 * 编译留下的兼容文件。调用方必须从对应 package 目录执行本脚本。
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

// npm 会把脚本的工作目录设为被调用 package；不能按脚本自身路径推断，
// 否则 Runtime 通过 `npm --prefix runtime` 调用时会误删 Backend 输出。
const packageRoot = resolve(process.cwd());
await rm(resolve(packageRoot, "dist"), { recursive: true, force: true });
