import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import WorkspaceLoginPage from "../src/features/auth/WorkspaceLoginPage.tsx";
import type { PortalEntryManifest, PortalUser } from "../src/api.ts";
import { installBrowserEnvironment, buttonWithText, requireElement } from "./react-test-harness.ts";

const manifest: PortalEntryManifest = {
  appId: "notes-demo",
  appName: "Notes",
  authProviderId: "none",
  capabilities: {},
  entry: {
    id: "notes-demo",
    label: "Notes",
    logoUrl: "/openapp-logo.png",
    challenge: "none",
    defaultWorkspace: "personal",
  },
};

for (const registration of [false, true]) {
  test(`local workspace ${registration ? "registration" : "login"} accepts ordinary users without SSO`, async () => {
    const browser = installBrowserEnvironment();
    const previousFetch = globalThis.fetch;
    const previousFormData = globalThis.FormData;
    globalThis.FormData = browser.window.FormData;
    const calls: string[] = [];
    const user: PortalUser = { id: "member", email: "member@example.test", role: "user" };
    let loggedIn: PortalUser | undefined;
    globalThis.fetch = async (input, init) => {
      calls.push(String(input));
      assert.deepEqual(JSON.parse(String(init?.body)), {
        email: user.email,
        password: "a test password only",
      });
      return Response.json({ user }, { status: registration ? 201 : 200 });
    };
    const root = createRoot(browser.container);
    try {
      await act(async () =>
        root.render(
          createElement(WorkspaceLoginPage, {
            manifest: registration ? manifest : { ...manifest, authProviderId: undefined },
            initialError: null,
            onLogin: (value) => {
              loggedIn = value;
            },
          }),
        ),
      );
      assert.equal(browser.container.querySelector('[role="alert"]'), null);
      if (registration)
        await act(async () => buttonWithText(browser.container, "New here? Create an account").click());
      requireElement<HTMLInputElement>(browser.container, "[name=email]").value = user.email;
      requireElement<HTMLInputElement>(browser.container, "[name=password]").value = "a test password only";
      await act(async () =>
        requireElement(browser.container, "form").dispatchEvent(
          new browser.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
      );
      assert.deepEqual(loggedIn, user);
      assert.deepEqual(calls, [registration ? "/api/auth/local/register" : "/api/auth/local/login"]);
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = previousFetch;
      globalThis.FormData = previousFormData;
      browser.restore();
    }
  });
}

test("local workspace does not display internal errors and allows retry", async () => {
  const browser = installBrowserEnvironment();
  const root = createRoot(browser.container);
  try {
    await act(async () =>
      root.render(
        createElement(WorkspaceLoginPage, {
          manifest,
          onLogin: () => {},
          initialError: new Error("private database endpoint"),
        }),
      ),
    );
    assert.equal(
      requireElement(browser.container, "[role=alert]").textContent,
      "Unable to sign in. Please try again.",
    );
    assert.equal(requireElement<HTMLButtonElement>(browser.container, "[type=submit]").disabled, false);
  } finally {
    await act(async () => root.unmount());
    browser.restore();
  }
});
