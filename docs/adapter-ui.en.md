# Adapter browser API

[Development guide](adapter-development.en.md) · [简体中文](adapter-ui.md)

This describes authUi API **1**, independently versioned from backend manifest
API v2 and contracts 0.2.x.

## Views and registration

| Extension                          | Scope                                                          |
| ---------------------------------- | -------------------------------------------------------------- |
| views.workspace                    | Application user's login layout, icon, fields and interactions |
| views.control                      | Application SSO button/panel inside administrator login        |
| Provider/manifest presentation     | Declarative labels, challenges and fields                      |
| manifest.build.packageRequirements | Generic upload form's named slots and limits                   |

The left OpenApp branding, local administrator form, roles and administration
pages remain Core-owned. There is no arbitrary menu/route/page injection API.
Multiple Adapters may be composed, but the browser selects the current/default
Provider; it does not automatically render a global Provider picker.

Declare the browser module in the Adapter's package.json and include assets in `files`:

```json
{
  "openapp": {
    "authUi": { "apiVersion": 1, "providerId": "sample-auth", "module": "auth-ui.mjs" }
  }
}
```

Put the module at `assets/auth-ui.mjs`. `module` is a filename, not an external URL.
Its Provider ID must match backend `authProvider.id` and `manifest.auth.providerId`;
it need not equal the App ID. UI registration does not register a backend Provider.
The exporter creates `/auth-adapters.json` and copies assets under
`/adapter-assets/<adapterId>/`. Reference CSS/images relative to the module, for
example `new URL('./login.css', import.meta.url).href`.

```js
export const apiVersion = 1;
export function createAuthUi({ React, request, ApiError }) {
  // 两个视图需自行实现；可复用 examples/email-code-ui 的完整实现。
  return { views: { workspace: WorkspaceLogin, control: ControlLogin } };
}
```

This is the factory shape, not a complete runnable module. Copy the working
[email-code-ui assets](../examples/email-code-ui/assets) for component implementations.
They contain no backend identity service.

| Host / component input | Contract                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| React                  | Use injected React/Hooks; do not bundle a second React instance                              |
| request(path, init?)   | Parsed JSON; credentials=include; JSON Content-Type except FormData; stringify body yourself |
| ApiError               | Constructor(status, code, requestId?); inspect these public fields                           |
| props.locale           | en or zh-CN; Adapter owns its translations                                                   |
| props.onLogin(user)    | Pass the authenticated server-returned PortalUser; Core updates session/navigation           |
| props.initialError     | Optional unknown; display only recognized public errors                                      |

Public types come from `@openapp/contracts/ui`, including `AuthUiLoginProps` and
`AuthUiFactory`. Components may share authentication hooks while keeping separate
workspace/control layouts. Do not import Core's private frontend types.

`request` throws ApiError for non-2xx responses. Network failures, including abort,
map to status 0 / `network_unavailable`; malformed success JSON maps to
`invalid_server_response`. Use AbortSignal and request-generation checks so an old
response cannot overwrite the challenge for a changed email address.

## Authentication sequence

| Request                                       | Body / result                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET /api/auth/methods                         | Available local/external methods                                                               |
| GET /api/entry/manifest                       | Current application entry and fields                                                           |
| POST /api/auth/external/:provider/email-codes | `{ email }` → `{ ok: true, providerData?, isNewUser? }`                                        |
| POST /api/auth/external/:provider/login       | `{ email, code, providerData? }` → `{ user, isNewUser, provider }`; server sets session Cookie |
| GET /api/auth/session                         | authenticated/status and user when signed in                                                   |

Send the code successfully **before** showing the verification-code step. On send
failure retain the email and show a mapped public error. Additional registration
fields follow Provider challenge data/public missing-field errors, not isNewUser
alone. Put extra values inside providerData, not at the request's top level. Code
format and length belong to the identity protocol, not a universal six-digit rule.

After success call only `onLogin(response.user)`. Credential grants/access/refresh
tokens stay in the backend, never localStorage. SSO success does not imply admin
authorization. Unknown or disallowed Providers return 404 auth_provider_not_found.

## Compatibility, safety and delivery

Generic mode calls `createAuthUi` and reads only views. Explicit legacy mode calls
`createAuthCompatibility`; modules supporting both must export/test both factories.
A legacy-only factory falls back to generic views in generic mode. Modern custom
UI does not require compatibilityMode.

A missing catalog or selected Provider means no extension. Invalid schema, path
or unsupported API is an error, not successful loading. Module paths are limited
to `/adapter-assets/<id>/<name>.mjs`.

Browser modules are reviewed same-origin code, not sandboxes. Do not embed secrets,
execute upstream strings, insert unfiltered HTML or override platform branding.
Scope CSS to your root class; provide labels, keyboard access, loading and error
states. Test send success/failure, existing/new accounts, extra fields, resend,
change-email, duplicate submits and stale responses in both views. See
[the UI example tests](../frontend/tests/adapter-ui-example.test.ts).

After asset changes recompose, verify and deploy the frontend image. Publish the
matching backend when Provider/entry contracts also change. See
[composition](composition-release.en.md) and [backend API](adapter-backend.en.md).
