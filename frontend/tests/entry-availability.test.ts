import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import App from "../src/App.tsx";
import { installBrowserEnvironment, waitFor } from "./react-test-harness.ts";

for (const catalogFailure of [false, true]) {
  test(`entry waits for manifest, methods and UI discovery before rendering a fallback (${catalogFailure})`, async () => {
    const browser = installBrowserEnvironment();
    const originalFetch = globalThis.fetch;
    const deferred = () => {
      let resolve!: (response: Response) => void;
      const promise = new Promise<Response>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const manifest = deferred();
    const methods = deferred();
    const catalog = deferred();
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/entry/manifest") return manifest.promise;
      if (url === "/api/auth/methods") return methods.promise;
      if (url === "/auth-adapters.json") return catalog.promise;
      return Response.json({ authenticated: false });
    };
    const root = createRoot(browser.container);
    const assertLoading = () => {
      assert.ok(browser.container.querySelector('[role="status"][aria-busy="true"]'));
      assert.equal(browser.container.querySelector("form"), null);
      assert.equal(browser.container.querySelector("img"), null);
      assert.equal(browser.container.textContent, "");
    };
    try {
      await act(async () => root.render(createElement(App)));
      assertLoading();
      await act(async () =>
        manifest.resolve(
          Response.json({
            appId: "sample",
            appName: "Sample",
            authProviderId: "sample-sso",
            compatibilityMode: false,
            capabilities: {},
            entry: {
              id: "sample",
              label: "Sample",
              logoUrl: "/sample.svg",
              challenge: "email_code",
              defaultWorkspace: "personal",
            },
          }),
        ),
      );
      await waitFor(() => assert.ok(requests.includes("/api/auth/methods")));
      assertLoading();
      await act(async () =>
        methods.resolve(
          Response.json({
            local: { enabled: true },
            admin: { localOnly: false },
            compatibilityMode: false,
            authProviderId: "sample-sso",
            external: [
              { id: "sample-sso", label: "Sample", challenge: "email_code", iconUrl: "/sample.svg" },
            ],
          }),
        ),
      );
      await waitFor(() => assert.ok(requests.includes("/auth-adapters.json")));
      assertLoading();
      await act(async () =>
        catalog.resolve(
          catalogFailure
            ? Response.json({ error: "internal_error" }, { status: 500 })
            : Response.json({ schemaVersion: 1, providers: {} }),
        ),
      );
      await waitFor(() => assert.ok(browser.container.querySelector(".generic-auth")));
      assert.equal(browser.container.querySelector('[aria-busy="true"]'), null);
      if (catalogFailure) assert.ok(browser.container.querySelector(".workspace-auth-error"));
      else
        assert.equal(browser.container.querySelector('input[type="email"]')?.hasAttribute("disabled"), false);
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      browser.restore();
    }
  });
}

for (const scenario of [
  { error: "adapter_not_configured", title: "尚未配置应用 Adapter" },
  { error: "internal_error", title: "应用入口暂不可用" },
]) {
  test(`home renders ${scenario.error} independently of the management page`, async () => {
    const browser = installBrowserEnvironment();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) =>
      String(input) === "/api/entry/manifest"
        ? Response.json(
            { error: scenario.error },
            { status: scenario.error === "internal_error" ? 500 : 409 },
          )
        : Response.json({ authenticated: false });
    const root = createRoot(browser.container);
    try {
      await act(async () => root.render(createElement(App)));
      await waitFor(() => assert.equal(browser.container.querySelector("h1")?.textContent, scenario.title));
      assert.equal(browser.container.querySelector("a")?.getAttribute("href"), "/control");
      assert.equal(browser.container.querySelector("form"), null);
      assert.equal(browser.container.querySelector(".app-shell"), null);
      assert.equal(browser.window.location.pathname, "/");
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      browser.restore();
    }
  });
}

for (const legacy of [true, false]) {
  test(`missing manifest falls back only for a confirmed legacy gateway (${legacy})`, async () => {
    const browser = installBrowserEnvironment();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input) === "/api/entry/manifest")
        return Response.json({ error: "not_found" }, { status: 404 });
      if (String(input) === "/api/auth/methods")
        return Response.json({
          local: { enabled: true },
          external: [],
          admin: { localOnly: false },
          ...(legacy ? {} : { compatibilityMode: false }),
        });
      return Response.json({ authenticated: false });
    };
    const root = createRoot(browser.container);
    try {
      await act(async () => root.render(createElement(App)));
      await waitFor(() => {
        if (legacy) assert.ok(browser.container.querySelector('input[type="email"]'));
        else assert.equal(browser.container.querySelector("h1")?.textContent, "应用入口暂不可用");
      });
      if (legacy) assert.equal(browser.container.querySelector("#entry-status-title"), null);
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      browser.restore();
    }
  });
}
