# Independent Adapter template

This is a declaration-only skeleton, not a runnable application integration.
For your first integration use the [runnable Notes Adapter](../notes-adapter/README.md)
and its [complete deployment tutorial](../../docs/adapter-tutorial.md).

Copy this directory into a new repository. Install a verified SDK tarball before
installing other dependencies: `npm install /path/to/openapp-contracts-0.2.0.tgz`.
Then run `npm install`, commit the generated lockfile and use `npm ci` thereafter.
The tarball must remain available at the lockfile URL/path; for shared builds use
a versioned release URL or a published registry version. Do not link Core source.

Implement `src/index.ts` with the public `OpenAppAdapterFactory`. The runnable
[Plain Web factory](../plain-web/index.mjs) shows a complete manifest; copy and
rename its IDs, then add only your application's capabilities. This skeleton
does not invent an identity service or executable runtime for your application.

For browser UI copy [email-code-ui assets](../email-code-ui/README.md), set the
registered Provider ID and implement the matching backend Provider. Browser types
are available from `@openapp/contracts/ui`, including `AuthUiLoginProps` and
`AuthUiFactory<typeof React, React.ComponentType<AuthUiLoginProps>>`.

Follow the [development guide](../../docs/adapter-development.md) before composing.
