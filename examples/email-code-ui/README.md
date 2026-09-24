# Email-code UI extension example

This copyable browser module implements `createAuthUi` API 1 with separate workspace and control views. It is an extension template, not an independently deployable Adapter or an identity service. It does not send real email, accept a fixed test code, store tokens or grant administrator roles. Use the [backend guide](../../docs/adapter-backend.md) to connect your actual identity service.

1. Copy `assets/` into your independent Adapter repository and include assets in its npm `files` list.
2. Set `providerId` in `assets/auth-ui.mjs` to the exact registered `authProvider.id` and `manifest.auth.providerId`. App ID and Provider ID may differ.
3. Merge this into that Adapter's package.json:

```json
{
  "openapp": {
    "authUi": { "apiVersion": 1, "providerId": "sample-auth", "module": "auth-ui.mjs" }
  }
}
```

4. Set `manifest.entry.challenge` and the Provider presentation challenge to `email_code`. `manifest.entry.id` must match the App ID. Compose with `compatibilityMode: false` and the matching Core version. No React dependency is bundled; Core injects React, request and ApiError.
5. Implement the two modern endpoints through the Provider contract. After a successful challenge, this example reads `providerData.requiresDisplayName === true` to request a display name; it then submits `providerData: { displayName }`. Existing users receive no extra field unless the service explicitly requires one. Rename this sample-specific field or omit it for your application. Do not infer registration requirements from `isNewUser`.

The workspace view opens the email form immediately. The control view first shows an application sign-in button. The code form appears only after a successful send request. Resend, duplicate-submission protection, safe public error text and stale-response cancellation are included. Changing email resets the prior challenge. CSS, logo and module use relative URLs under the Adapter's deployed asset directory. The control view never replaces Core's left branding or local administrator form.

Supported example error codes are `verification_code_invalid` and `display_name_required`; other errors show generic text without exposing raw upstream details. Production Providers must enforce expiry, attempts and rate limits. Frontend validation is not an authentication control.

From the Core root, after frontend dependencies are installed:

```sh
npm --prefix frontend run typecheck
npm --prefix frontend test
```

[The interaction tests](../../frontend/tests/adapter-ui-example.test.ts) load the actual module and exercise both views, challenge-dependent fields, modern payloads, request failures, duplicate submissions and stale responses. Tests mock only the HTTP boundary; no account or database is changed. See the [UI contract](../../docs/adapter-ui.md) and [source map](../../docs/adapter-source-map.md) for integration points.
