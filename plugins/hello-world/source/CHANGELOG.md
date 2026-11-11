# Changelog

## [0.4.1] - Unreleased

Require Ave 0.15.0, the first released app with host protocol 5. The existing published descriptor remains pinned until this version has a release asset.

## [0.4.0] - Unreleased

Serve the sidebar as self-contained MCP Apps HTML and call hello_world through the standard App SDK. Require host protocol 5 and Ave 0.14.2.

## [0.3.2] - Unreleased

Removes the retired product name from the demo extension. Requires Ave 0.14.0
and host protocol 3, as before. The `hello_world` tool and the panel are
unchanged.

### Changed

- The package name is `@ave/plugin-hello-world`, and the build imports the
  `@ave/plugin-contract` types and `defineAvePluginConfig` from
  `@ave/plugin-build`.

## [0.3.1]

The first release from this repository (GitHub release
`hello-world-v0.3.1`). Earlier versions were not recorded here.
