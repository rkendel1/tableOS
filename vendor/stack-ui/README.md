# Vendored: Boundry design foundation (@stack-ui 0.7.0)

The shared design foundation (`rkendel1/stack-ui`), vendored until the packages
are published to npm (stack-ui `docs/decisions.md` D9). Each directory is an
unpacked package (`pnpm pack` of `packages/<name>`), unmodified. The dashboard
build bundles them (they are devDependencies of `@feltdb/feltkit`, so nothing
is added to the published package's dependencies). `test/design-foundation.test.ts`
checks every file against `SHA256SUMS`.

To upgrade: replace each directory with the unpacked package of the new
release, regenerate `SHA256SUMS` with
`node <stack-ui>/scripts/vendor-packages.mjs vendor/stack-ui`,
update the versions in `package.json`, and run `npm install` at the repository root.
