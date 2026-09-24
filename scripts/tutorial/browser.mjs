/** Optional browser acceptance. Playwright is installed in the lab, not the business app or Core. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const release = resolve(process.argv[2] ?? "");
const lab = dirname(release);
const state = JSON.parse(await readFile(join(lab, "tutorial-state.json"), "utf8"));
if (
  !/^openapp-tutorial-[a-f0-9]{12}$/.test(state.project) ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(state.origin)
)
  throw Error("expected a local tutorial environment");
const { chromium } = await import(
  pathToFileURL(resolve(process.argv[3] ?? join(lab, "browser-tools/node_modules/playwright/index.mjs"))).href
);
const accounts = JSON.parse(await readFile(join(lab, "tutorial-accounts.json"), "utf8"));
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const pages = [];
  for (const [index, account] of accounts.entries()) {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(state.origin);
    await page.locator('[name="email"]').waitFor();
    assert.equal(await page.getByRole("alert").count(), 0, "fresh login must not show an error");
    if (index === 0) await page.screenshot({ path: join(lab, "tutorial-login.png"), fullPage: true });
    await page.locator('[name="email"]').fill(account.email);
    await page.locator('[name="password"]').fill(account.password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL(/\/instances\/[^/]+\/ui\//, { timeout: 180_000 });
    await page.locator("#status").filter({ hasText: "已读取" }).waitFor();
    assert.equal(await page.locator("#note").inputValue(), `private note ${index}`);
    await page.locator("#note").fill(`浏览器独立笔记 ${index}`);
    await page.getByRole("button", { name: "保存笔记" }).click();
    await page.locator("#status").filter({ hasText: "已保存" }).waitFor();
    pages.push(page);
  }
  assert.notEqual(pages[0].url(), pages[1].url());
  for (const [index, page] of pages.entries()) {
    await page.reload();
    await page.locator("#status").filter({ hasText: "已读取" }).waitFor();
    assert.equal(await page.locator("#note").inputValue(), `浏览器独立笔记 ${index}`);
    await page.screenshot({ path: join(lab, `tutorial-user-${index}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    join(lab, "tutorial-browser.json"),
    JSON.stringify(
      { passed: true, accounts: 2, browserErrors: errors, date: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log("PASS browser login, automatic app entry, independent notes, save and reload; no page errors");
} finally {
  await browser.close();
}
