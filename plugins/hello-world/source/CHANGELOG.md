# Changelog

## [0.4.0] - Unreleased

The version, host protocol, minimum Ave version, and authority in the [marketplace descriptor](../ave-package.json) match this source release. Its `payload.artifact.release` still names the protocol-3 ZIP; release preparation must replace that pin with the published protocol-5 ZIP and its verified SHA-256 before catalog publication.

Requires Ave 0.14.2 and host protocol 5. Ave 0.14.2 serves protocol 5 only
and refuses a protocol-3 extension before activation. The `hello_world` tool
and the panel are unchanged.

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
