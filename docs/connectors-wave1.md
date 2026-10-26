# Connector wave 1

Understood as: complete the owner's 12-connector selection with ten additions on current main, preserving its Slack and GitLab connectors, using the current manifest contract and host-provisioned secrets, without merging the old branch or publishing packages.

The ten additions are Jira, Confluence, Trello, Todoist, Airtable, Obsidian, Figma, YouTube, Google Workspace and Microsoft 365. Together with Slack and GitLab already on main, these make twelve. Jira and Confluence are separate connectors using one upstream. The October 16 research document's “14 apps” heading does not describe this count, and its optional Discord entry was dropped by the owner on October 17. The existing `atlassian-mcp` is a skill. Existing GitHub and Notion packages also remain available, covering the research document's verified Aside examples alongside Slack, Figma and Google Workspace; that document establishes no exhaustive Aside connector catalog.

Discord is excluded by owner decision. The old branch's `slack-community-mcp` and `gitlab-community-mcp` are excluded as duplicates. No selected upstream was excluded for licensing.

## Verified sources

Checked live on October 26, 2026 with `gh api`: repository metadata, commit objects, tag-to-commit mappings where available, recursive trees, actual LICENSE text, package metadata and relevant implementation files **at the SHA below**. All nine upstream repositories were unarchived, and all nine LICENSE files were MIT. Latest metadata alone was not used as license evidence. SHA links lead to the reviewed source; LICENSE links use that same SHA.

| Connectors | Upstream source SHA | License at SHA | Runtime pin |
|---|---|---|---|
| Jira, Confluence | [sooperset/mcp-atlassian · 5be93a041385e2ba076478787946d93ae02c663f](https://github.com/sooperset/mcp-atlassian/tree/5be93a041385e2ba076478787946d93ae02c663f) | [MIT](https://github.com/sooperset/mcp-atlassian/blob/5be93a041385e2ba076478787946d93ae02c663f/LICENSE) | `mcp-atlassian==0.23.1` |
| Trello | [delorenj/mcp-server-trello · c3e1e92e715a71e1142c21e8ced520dc1b33ef60](https://github.com/delorenj/mcp-server-trello/tree/c3e1e92e715a71e1142c21e8ced520dc1b33ef60) | [MIT](https://github.com/delorenj/mcp-server-trello/blob/c3e1e92e715a71e1142c21e8ced520dc1b33ef60/LICENSE) | `@delorenj/mcp-server-trello@1.8.1` |
| Todoist | [Doist/todoist-mcp · 788feb35599f7794ed923da41b08060ae8f4976e](https://github.com/Doist/todoist-mcp/tree/788feb35599f7794ed923da41b08060ae8f4976e) | [MIT](https://github.com/Doist/todoist-mcp/blob/788feb35599f7794ed923da41b08060ae8f4976e/LICENSE) | `@doist/todoist-mcp@13.6.3` |
| Airtable | [domdomegg/airtable-mcp-server · e8b6dc621858becb6e685cab57d00fb2b0cf0ba9](https://github.com/domdomegg/airtable-mcp-server/tree/e8b6dc621858becb6e685cab57d00fb2b0cf0ba9) | [MIT](https://github.com/domdomegg/airtable-mcp-server/blob/e8b6dc621858becb6e685cab57d00fb2b0cf0ba9/LICENSE) | `airtable-mcp-server@1.14.0` |
| Obsidian | [MarkusPfundstein/mcp-obsidian · 5ee0b84fa8319fd2fdf0db0ee1febb065e712a15](https://github.com/MarkusPfundstein/mcp-obsidian/tree/5ee0b84fa8319fd2fdf0db0ee1febb065e712a15) | [MIT](https://github.com/MarkusPfundstein/mcp-obsidian/blob/5ee0b84fa8319fd2fdf0db0ee1febb065e712a15/LICENSE) | `uvx --from git+…@5ee0b84fa8319fd2fdf0db0ee1febb065e712a15 mcp-obsidian` |
| Figma | [GLips/Figma-Context-MCP · 24713d888b56bfbec97abf66db3afea4b8ecb9e4](https://github.com/GLips/Figma-Context-MCP/tree/24713d888b56bfbec97abf66db3afea4b8ecb9e4) | [MIT](https://github.com/GLips/Figma-Context-MCP/blob/24713d888b56bfbec97abf66db3afea4b8ecb9e4/LICENSE) | `figma-developer-mcp@0.13.2` |
| YouTube | [ZubeidHendricks/youtube-mcp-server · 7a3f6e72b8ff7643456f6b6f2cd5dab293cd3551](https://github.com/ZubeidHendricks/youtube-mcp-server/tree/7a3f6e72b8ff7643456f6b6f2cd5dab293cd3551) | [MIT](https://github.com/ZubeidHendricks/youtube-mcp-server/blob/7a3f6e72b8ff7643456f6b6f2cd5dab293cd3551/LICENSE) | `zubeid-youtube-mcp-server@1.0.2` |
| Google Workspace | [taylorwilsdon/google_workspace_mcp · b5cf07e6078ae10a596710d77569e9430e01ebd4](https://github.com/taylorwilsdon/google_workspace_mcp/tree/b5cf07e6078ae10a596710d77569e9430e01ebd4) | [MIT](https://github.com/taylorwilsdon/google_workspace_mcp/blob/b5cf07e6078ae10a596710d77569e9430e01ebd4/LICENSE) | `uvx --from git+…@b5cf07e6078ae10a596710d77569e9430e01ebd4 python server/launch.py` |
| Microsoft 365 | [Softeria/ms-365-mcp-server · 08d8977ba9d229ce164d267848ab3b74a52d0c23](https://github.com/Softeria/ms-365-mcp-server/tree/08d8977ba9d229ce164d267848ab3b74a52d0c23) | [MIT](https://github.com/Softeria/ms-365-mcp-server/blob/08d8977ba9d229ce164d267848ab3b74a52d0c23/LICENSE) | `@softeria/ms-365-mcp-server@0.172.0` |

The npm registry's `gitHead` matched the table for Todoist, Airtable, YouTube and Microsoft 365. Trello and Figma publish no `gitHead`; their source tags and registry package versions/licenses were checked, but their built npm artifacts are not claimed to be reproducible from the source SHA. Like the existing Slack/GitLab descriptors, npm/PyPI pins select an exact package version, not locked transitive dependencies. Obsidian has no release tag and its reviewed `pyproject.toml` says 0.2.2, so the old branch's unproven 0.2.3 package mapping is replaced with a full Git SHA pin. Ave's direct `uvx` descriptor form accepts only exact registry versions; the packaged launcher runs the SHA-pinned source instead. Google uses a full Git SHA pin because the adapter depends on its credential-store API. Todoist requires Node 24 or later.

## Setup and access

Install the desired MCP package from Ave's marketplace, then configure its server in Ave. Enter secrets only in Ave's secret prompt. No descriptor, argument, `.env`, client-secret file or token-cache file should contain credentials. Nonsecret site URLs and usernames belong in Ave's server environment settings. Jira and Confluence presets use Cloud API-token auth; Data Center PAT auth uses different upstream variables and is not configured by these presets. The Trello, Obsidian, Google Workspace and Microsoft 365 launchers require macOS or Linux and declare that platform boundary in their descriptors.

| Connector | Host secret destination | Default access |
|---|---|---|
| [Jira](../mcp/jira-mcp/ave-package.json) | `JIRA_API_TOKEN` | `--read-only` and `READ_ONLY_MODE=true`; set `JIRA_URL`, `JIRA_USERNAME` |
| [Confluence](../mcp/confluence-mcp/ave-package.json) | `CONFLUENCE_API_TOKEN` | Same read-only controls; set `CONFLUENCE_URL`, `CONFLUENCE_USERNAME` |
| [Trello](../mcp/trello-mcp/ave-package.json) | `TRELLO_CREDENTIALS` | No upstream read-only switch. Supply a token authorized with `scope=read`; write tools stay listed. |
| [Todoist](../mcp/todoist-mcp/ave-package.json) | `TODOIST_API_KEY` | No upstream read-only switch; read and write tools exposed. |
| [Airtable](../mcp/airtable-mcp/ave-package.json) | `AIRTABLE_API_KEY` | No upstream read-only switch. Supply a PAT with only `schema.bases:read` and `data.records:read`, limited to the needed bases; write tools stay listed. |
| [Obsidian](../mcp/obsidian-mcp/ave-package.json) | `OBSIDIAN_API_KEY` | No upstream read-only switch; reads and writes vault notes through the Local REST API plugin at `https://127.0.0.1:27124`. |
| [Figma](../mcp/figma-context-mcp/ave-package.json) | `FIGMA_API_KEY` | Reads Figma designs and downloads images locally. Telemetry off. |
| [YouTube](../mcp/youtube-mcp/ave-package.json) | `YOUTUBE_API_KEY` | Read-only video/channel/playlist search and transcripts; explicit stdio transport. |
| [Google Workspace](../mcp/google-workspace-mcp/ave-package.json) | `GOOGLE_WORKSPACE_CREDENTIALS` | `--read-only`, core tier, Gmail/Calendar/Drive/Docs/Sheets only; memory-only OAuth credentials. |
| [Microsoft 365](../mcp/ms-365-mcp/ave-package.json) | `MS365_MCP_OAUTH_TOKEN` | `--read-only` plus an explicit read-scope allowlist; bring an existing delegated Graph access token. |

Trello needs two credential values, while the current host schema injects one secret environment variable. Enter one JSON object in the secret prompt: `{"apiKey":"<API key>","token":"<read-scoped token>"}`. Its launcher splits this in memory into the two upstream environment variables, removes the combined value from the child environment, and passes no secret on the command line.

Google's stock local OAuth flow stores credentials in files. This adapter instead accepts one JSON secret: `{"email":"<account email>","client_id":"<desktop OAuth client ID>","client_secret":"<client secret>","refresh_token":"<refresh token>"}`. Obtain the refresh token using your own Google desktop OAuth client, with offline access and the `gmail.readonly`, `calendar.readonly`, `drive.readonly`, `documents.readonly` and `spreadsheets.readonly` scopes under `https://www.googleapis.com/auth/`. The adapter binds credentials to that email, installs the upstream `CredentialStore` implementation in memory, blocks OAuth state creation, disables `start_google_auth`, and disables the upstream file logger. It may create an empty credentials directory under Ave's data directory; it never writes the credentials there. Refreshed access tokens stay in memory. If Google rotates or revokes the refresh token, update the host secret before the next launch. Ave cannot receive a rotated token back through this descriptor schema. Interactive OAuth onboarding inside the connector is unavailable.

Microsoft's stock stdio server loads a local auth cache even in bring-your-own-token mode. The launcher installs the upstream external auth-cache command: loads return “not found”, deletes are no-ops, and saves fail closed with a message directing the user to Ave. The upstream cannot fall back to file/keytar storage when this command is set. Local login cannot persist. Replace the delegated Graph token in Ave when it expires; the connector does not refresh it. Request only these delegated Graph scopes: `User.Read Mail.Read Calendars.Read Contacts.Read Files.Read Tasks.Read MailboxSettings.Read Notes.Read`. The [launcher](../mcp/ms-365-mcp/server/launch.mjs) supplies the same scope allowlist. It filters exposed tools and does not reduce permissions already granted to a supplied token. Logs use Ave's data directory and upstream secret/PII redaction is forced on.

Read-only here limits service mutations, not local writes such as image or attachment downloads. Scoped Trello/Airtable tokens are a user setup requirement rather than a server-side mode. No provider account was authenticated during validation; MCP initialization, tool enumeration and adapter tests do not prove provider login, token refresh, or service API calls.

## Targeted checks

Run the repository checks using the Node/Bun versions and cosign setup described in the [root README](../README.md#checks) and [validation workflow](../.github/workflows/validate.yml). Generate the index only after the package commit exists; its version entries refer to that commit.

```sh
node tools/release.mjs verify --base origin/main
node tools/index.mjs --check
node tools/vendor.mjs check
node tools/verified-import.mjs check --allow-development
node tools/check-retired-name.mjs
node --test tools/__tests__/tools.test.mjs tools/__tests__/connectors-wave1.test.mjs
uvx --from 'git+https://github.com/taylorwilsdon/google_workspace_mcp@b5cf07e6078ae10a596710d77569e9430e01ebd4' python mcp/google-workspace-mcp/server/test_launch.py
git diff --check
```

The focused adapter tests check malformed-secret rejection, child-only credential injection, cache-write refusal, upstream failure propagation, account binding and in-memory token updates. A credential-free protocol smoke check must also initialize each pinned server and enumerate its tools when changing these pins or adapters. For the read-only presets, inspect the actual tool surface for service mutation tools. No extension source changed, so local extension builds and unrelated provider tests are outside this check scope.

The October 26 implementation passed credential-free MCP initialization and tool enumeration for all ten additions: Jira 38 tools, Confluence 20, Trello 57, Todoist 47, Airtable 16, Obsidian 15, Figma 2, YouTube 10, Google Workspace 11 and Microsoft 365 83. Jira and Confluence listed only tools marked read-only. Google's list contained only lookups and downloads, with no auth tool. Microsoft's Graph tools had no write annotations; its six local account/auth tools remain listed, with credential persistence blocked by the adapter. The five Node adapter tests, two Python adapter tests and sixty repository tool tests passed locally. Repository validation and index checks must be run after indexing; CI status belongs to the PR, not this source-verification record.
