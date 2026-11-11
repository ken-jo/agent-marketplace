# agent-marketplace

The official Ave marketplace. Ave syncs this repository with git and installs packages from it. The upstream design is `ken-jo/ave/docs/design/multi-source-git-marketplace.md`.

Code packages are called **extensions** in user-facing text. They use the `plugin` kind and `plugins/` paths. The separate `agent-plugin` kind contains Agent Plugins without an Ave runtime entry.

## Layout

| Path | Contents |
|---|---|
| `marketplace.json` | Generated schemaVersion 2 catalog. Run `bun run index` to update it. |
| `plugins/<name>/source/` | Official extension sources, each with its own package manifest and lockfile. |
| `plugins/<name>/ave-package.json` | Extension descriptor, written by `tools/release.mjs pin` after its first release. |
| `agent-plugins/` | Agent Plugin packages with declared components. |
| `mcp/`, `skills/`, `agents/`, `fonts/`, `languages/`, `providers/`, `messaging/` | Content packages, each with an `ave-package.json`. |
| `policy/` | Revocations, including optional app-version-scoped revocations. |
| `tools/withdrawn.json` | Optional explicit withdrawals of published packages. |
| `templates/extension/` | Extension starting point. |
| `contract/` | Ave public types, manifest schema and protocol 5 schema. |
| `tools/vendor/` | Built Ave repository validator and Agent Plugin component extractor. |
| `tools/` | Repository checks, catalog generator, release tools and extension build helper. |

Content entries without `versions` resolve their descriptors at the fetched commit. `node tools/index.mjs --pin-versions` records explicit version pins once the package commits exist. Published versions remain immutable, apart from `yanked` and `rollout`, unless the whole package is withdrawn or its kind is explicitly retired in `tools/repo.mjs`.

An indexed version absent from the published base can be corrected without changing a published pin. Commit the corrected package, then regenerate with `node tools/index.mjs --base <published-ref> --repin <kind/name>@<version>=<corrected-commit>`. The generator refuses to re-pin any version listed at that base.

## Ave contract

Ave 0.15.0 is the first protocol-5 app release. The release input is [`tools/ave-release.json`](tools/ave-release.json); both `sources.json` files are generated provenance. Until the app is tagged, it pins the reviewed Ave main commit. After tagging, change that file's `ref` to the v0.15.0 tag commit and regenerate from a local Ave checkout:

```sh
node tools/vendor.mjs sync --app <Ave-checkout>
node tools/vendor.mjs check
```

The sync command regenerates `contract/` and `tools/vendor/`, including both provenance files. Commit the generated diff together with the pin change.

Sync resolves the ref with git, accepts only regular blob entries (modes 100644 and 100755), reads tracked files with `git show`, and builds the helpers from those files using the ref's frozen Bun dependencies. It never reads source from the checkout's working tree. Each `sources.json` records the repository, given ref, resolved commit, and source paths or build entries. `check` is offline and checks that listed files exist and both generated refs match the release pin. Review the ref and generated diff before committing; changes to the contract belong in Ave.

| Destination | Ave source or build entry |
|---|---|
| `contract/public-contract.ts` | `src/plugins/public-contract.ts` |
| `contract/plugin-manifest.schema.json` | `schemas/plugin-manifest.schema.json` |
| `contract/protocol.schema.json` | `schemas/plugin-host-protocol/5/protocol.schema.json` |
| `tools/vendor/agent-plugin-components.js` | `src/marketplace/content/agent-plugin-components.ts` (built) |
| `tools/vendor/marketplace-check.js` | `src/marketplace/repository-check.ts` (required build entry) |

The build recipe replaces the host logger with a silent logger so standalone helpers do not start its worker transport. Repository tools import the committed helpers directly.

## Checks

Use the Node engine in [package.json](package.json) and Bun version in the [validation workflow](.github/workflows/validate.yml).

```sh
bun run contract:check
bun run validate
bun run index:check
bun run test:tools
node tools/check-retired-name.mjs
node tools/plugin-check.mjs tools/plugin-build --helper
node tools/plugin-check.mjs plugins/<name>/source
```

The plugin check runner installs frozen dependencies, then runs typecheck, build, tests, and any declared `validate:events`, `validate:hostapi`, and `validate:manifest` scripts. The helper runs typecheck and tests only.

`node tools/release.mjs verify --base origin/main` downloads plugin releases, checks their asset hashes and tagged manifests, then runs repository validation. Without a base it checks all pinned releases. `validate` needs each required released manifest supplied as `--released <plugin>@<version>=<path>`; when one is missing it prints a command to obtain it. Plugin release asset hashes remain part of the catalog's artifact pins.

See [Connector wave 1](docs/connectors-wave1.md) for connector setup and checks.

## Publishing

Publishing is owner-operated. A merge to `main` publishes catalog changes. Review, git history checks and Ave's permission review protect installs and updates.

For Ave 0.15.0, publish the app first, repoint the [release pin](tools/ave-release.json) to its tag commit and regenerate the contract/checker, then release hello-world 0.4.1, local-indexer 0.8.2 and meeting 0.10.4. Their new sources require Ave 0.15.0 and protocol 5. Existing descriptors and catalog versions retain their immutable release assets and authority until the owner publishes those new assets and merges their generated pin PRs. The Korean language pack is withdrawn because Korean UI is built into Ave.

For an extension release, raise its `plugin.json` and `package.json` versions together and keep descriptor authority consistent with its manifest. The owner runs the release workflow, which builds and tests with read-only permissions, then creates the release in a separate job and opens a pull request pinning its asset. Merging that pull request publishes the version. Merge commits preserve catalog history.

The release workflow's pin pull requests require the repository setting “Allow GitHub Actions to create and approve pull requests”. If a release exists but its pin branch was not pushed, recover on a branch from current `main`:

```sh
gh release download <name>-v<version> --pattern '*.zip' --dir /tmp/rel
node tools/release.mjs pin <name> /tmp/rel/<name>-<version>.zip
git commit -am "Pin <name> <version> to its release asset"
bun run index
```

Publication commands reject `MARKETPLACE_ROOT`; that override is for repository test fixtures. For other packages, raise `version` in `ave-package.json`, commit the package, and regenerate the catalog.
