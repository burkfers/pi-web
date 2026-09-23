# Development and delivery checks

Keep the frequent feedback loop focused on application behavior. Compilation and packaging have their own required delivery steps.

## During development

Run the smallest relevant test first:

```sh
npm test -- src/server/plugins/serverPluginRuntime.test.ts
```

Before merging cross-cutting changes, run:

```sh
npm run verify
```

This runs typechecking, lint, unused-code analysis, and the ordinary test suite. Use the [testing guide](../.agents/skills/testing-guide/SKILL.md#decide-whether-a-test-adds-protection) to decide which behaviors merit automation and choose their smallest sufficient boundary.

## Before delivery

If the isolated development pair is running, stop it before building because
`npm run build` removes the generated `dist/` tree that the development session
daemon watches:

```sh
scripts/dev-pair.sh stop
npm run build
npm run check:artifacts
```

The build guard refuses to run while the pair is live; start the pair again
after verification when you need to test the UI.

`check:artifacts` consumes the current `dist` output; it does not build or refresh it. Always run the build first after changing source or packaging inputs. Artifact checks cover emitted public declarations, package contents, deployment-relative client URLs, and plugin bundle contracts such as self-containment and size limits. They are separate from `npm test` and `npm run verify`.

CI and the publish workflow run artifact checks after their build. On Linux they also run `npm run smoke:package-install`, which checks an actual global installation, public API consumer resolution, and native PTY execution. That installed-package boundary is distinct from inspecting build output.

