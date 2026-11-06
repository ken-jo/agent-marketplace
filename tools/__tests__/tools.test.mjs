/**
 * The repository tools against scratch git repositories: index generation
 * (design §4.3) and the checks only this repository makes (tools/check.mjs).
 * Run with `node --test tools/__tests__`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { checkMarketplaceRepository } from "../vendor/marketplace-check.js";
import { compareVersions, workingTree } from "../repo.mjs";


const TOOLS = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REAL_ROOT = resolve(TOOLS, "..");
const scratch = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const AUTHORITY = { capabilities: [], requires: { minAppVersion: "0.10.0" } };
const SHA = "b".repeat(64);

function plugin(version, sha256 = SHA) {
  return {
    schemaVersion: 2,
    kind: "plugin",
    name: "alpha",
    version,
    minAppVersion: "0.10.0",
    payload: {
      authority: AUTHORITY,
      artifact: { release: { repo: "ken-jo/agent-marketplace", tag: `alpha-v${version}`, asset: `alpha-${version}.zip`, sha256 } },
    },
  };
}

function skill(version) {
  return { schemaVersion: 2, kind: "skill", name: "review", version, minAppVersion: "0.10.0", payload: { entry: "SKILL.md" } };
}

/** A scratch marketplace using local copies of the tools and contract. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marketplace-tools-")));
  scratch.push(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  cpSync(join(REAL_ROOT, "contract"), join(root, "contract"), { recursive: true });
  cpSync(join(REAL_ROOT, "tools/vendor"), join(root, "tools/vendor"), { recursive: true });
  for (const script of readdirSync(TOOLS).filter((name) => name.endsWith(".mjs"))) {
    cpSync(join(TOOLS, script), join(root, "tools", script));
  }
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  write("marketplace.json", { schemaVersion: 2, name: "ave", displayName: "Ave Official", packages: [] });
  const commit = (message) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  const installed = (script) => realpathSync(join(root, "tools", script));
  const runTool = (script, args, env) => spawnSync("node", [installed(script), ...args], { env, encoding: "utf8" });
  const tool = (script, ...args) => runTool(script, args, { ...process.env, MARKETPLACE_ROOT: root });
  const publishTool = (script, ...args) => {
    const env = { ...process.env };
    delete env.MARKETPLACE_ROOT;
    return runTool(script, args, env);
  };
  /** Run `body` as a module with the tools module `script`'s exports in scope as `m`, against this repository. */
  const evaluate = (script, body) => spawnSync("node", ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(installed(script))}); ${body}`,
  ], { env: { ...process.env, MARKETPLACE_ROOT: root }, encoding: "utf8" });
  const index = () => JSON.parse(readFileSync(join(root, "marketplace.json"), "utf8"));
  /** Evaluate `expression` with the tools module `script`'s exports in scope as `m`, against this repository. */
  const call = (script, expression) => {
    const out = evaluate(script, `console.log(JSON.stringify(${expression}));`);
    if (out.status !== 0) throw new Error(`${script}: ${expression} failed: ${out.stderr}`);
    return JSON.parse(out.stdout);
  };
  const r = { root, git, write, commit, tool, publishTool, evaluate, index, call };
  return r;
}

function withSourcePlugin(r, version) {
  r.write("plugins/alpha/ave-package.json", plugin(version));
  r.write("plugins/alpha/source/plugin.json", {
    name: "alpha",
    version,
    extensions: { "ai.agent-connector.ave": { ...AUTHORITY, entry: "dist/hostPlugin.js", tools: [] } },
  });
  r.write("plugins/alpha/source/package.json", { name: "@ave/plugin-alpha", version });
}

function withMeetingNotesKit(r) {
  cpSync(join(REAL_ROOT, "agent-plugins/meeting-notes-kit"), join(r.root, "agent-plugins/meeting-notes-kit"), { recursive: true });
}

describe("index generation", () => {
  it("retires only the explicit historical theme kind", () => {
    const r = repo();
    r.write("marketplace.json", { schemaVersion: 2, name: "ave", displayName: "Ave Official", packages: [{ kind: "theme", name: "old", path: "themes/old", versions: [{ version: "1.0.0", commit: "a".repeat(40) }] }] });
    const base = r.commit("historical kind");
    const result = r.tool("index.mjs");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(r.index().packages, []);
    assert.equal(r.tool("check.mjs", "--base", base).status, 0);
  });

  it("rejects unknown historical kinds even without published versions", () => {
    for (const versions of [undefined, [{ version: "1.0.0", commit: "a".repeat(40) }]]) {
      const r = repo();
      r.write("marketplace.json", { schemaVersion: 2, name: "ave", displayName: "Ave Official", packages: [{ kind: "typo", name: "old", path: "typo/old", versions }] });
      const base = r.commit("unknown kind");
      assert.match(r.tool("index.mjs").stderr, /unknown package kind typo/u);
      r.write("marketplace.json", { schemaVersion: 2, name: "ave", displayName: "Ave Official", packages: [] });
      assert.match(r.tool("check.mjs", "--base", base).stderr, /unknown package kind typo/u);
    }
    const r = repo();
    r.write("skills/review/ave-package.json", { ...skill("1.0.0"), kind: "typo" });
    r.commit("unknown descriptor kind");
    assert.match(r.tool("index.mjs").stderr, /unknown package kind typo/u);
  });

  it("re-pins only unpublished versions against an explicit published base", () => {
    const r = repo();
    const base = r.commit("empty published base");
    r.write("skills/review/ave-package.json", skill("1.0.0"));
    r.write("skills/review/SKILL.md", "---\nname: review\ndescription: Review.\n---\nBody.\n");
    r.commit("unpublished package");
    assert.equal(r.tool("index.mjs").status, 0);
    const indexed = r.commit("unpublished index");
    r.write("skills/review/ave-package.json", { ...skill("1.0.0"), minAppVersion: "0.14.2" });
    const corrected = r.commit("correct unpublished minimum");
    const pin = `skill/review@1.0.0=${corrected}`;
    assert.match(r.tool("index.mjs", "--repin", pin).stderr, /needs --base/u);
    assert.match(r.tool("index.mjs", "--base", indexed, "--repin", pin).stderr, /published at .*cannot re-pin/u);
    const orphan = r.git("commit-tree", r.git("rev-parse", `${base}^{tree}`).trim(), "-m", "unrelated base").trim();
    assert.match(r.tool("index.mjs", "--base", orphan, "--repin", pin).stderr, /base must be in HEAD/u);
    const result = r.tool("index.mjs", "--base", base, "--repin", pin);
    assert.equal(result.status, 0, result.stderr);
    const [version] = r.index().packages[0].versions;
    assert.equal(version.commit, corrected);
    assert.equal(version.minAppVersion, "0.14.2");
    r.commit("corrected index");
    assert.equal(r.tool("index.mjs", "--check").status, 0);
    assert.equal(r.tool("check.mjs", "--base", base).status, 0);
  });

  it("keeps descriptor-resolved entries in a single-commit import and pins them on request", () => {
    const r = repo();
    r.write("skills/review/ave-package.json", skill("1.0.0"));
    r.write("skills/review/SKILL.md", "# Review\nReview code carefully.\n");
    r.write("marketplace.json", {
      schemaVersion: 2,
      name: "ave",
      displayName: "Ave Official",
      packages: [{ kind: "skill", name: "review", path: "skills/review" }],
    });
    const initial = r.commit("single-commit import");
    assert.equal(r.tool("index.mjs", "--check").status, 0);
    assert.equal(r.tool("check.mjs").status, 0);
    assert.equal(r.index().packages[0].versions, undefined);
    const pinned = r.tool("index.mjs", "--pin-versions");
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(r.index().packages[0].versions[0].commit, initial);
    r.commit("first explicit pins");
    assert.equal(r.tool("index.mjs", "--check").status, 0);
  });

  it("indexes the tag-derived agent-plugin components and refuses changed package bytes", () => {
    const r = repo();
    withMeetingNotesKit(r);
    const commit = r.commit("meeting notes kit");
    const result = r.tool("index.mjs");
    assert.equal(result.status, 0, result.stderr);
    const [entry] = r.index().packages;
    const descriptor = JSON.parse(readFileSync(join(r.root, "agent-plugins/meeting-notes-kit/ave-package.json"), "utf8"));
    assert.equal(entry.kind, "agent-plugin");
    assert.equal(entry.versions[0].commit, commit);
    assert.deepEqual(entry.versions[0].components, descriptor.payload.components);
    assert.equal(entry.versions[0].hostProtocol, undefined);
    assert.deepEqual(entry.versions[0].components.skills.map((skill) => skill.name), ["meeting-notes"]);
    assert.deepEqual(entry.versions[0].components.prompts.map((prompt) => prompt.kind), ["template"]);
    assert.deepEqual(entry.versions[0].components.routineTemplates.map((routine) => routine.id), ["weekly-notes-review"]);
    assert.deepEqual(entry.versions[0].components.mcpServers, {});
    assert.deepEqual(entry.versions[0].components.hooks, []);
    r.commit("index");
    assert.equal(r.tool("check.mjs").status, 0);
    assert.equal(r.tool("index.mjs", "--check").status, 0);

    const tampered = r.index();
    tampered.packages[0].versions[0].components.prompts[0].digest = "a".repeat(64);
    r.write("marketplace.json", tampered);
    assert.match(r.tool("index.mjs", "--check").stderr, /components differs from .*ave-package\.json at/u);
    r.git("checkout", "--", "marketplace.json");

    r.write("agent-plugins/meeting-notes-kit/ai.agent-connector.ave/prompts/meeting-notes.md", "---\nname: meeting-notes\ndescription: Draft notes.\nkind: template\n---\nChanged instructions.\n");
    r.commit("changed prompt without version");
    assert.match(r.tool("index.mjs", "--check").stderr, /components differ from package files/u);
    assert.match(r.tool("check.mjs").stderr, /agent-plugin components differ from the package tree/u);
    r.write("agent-plugins/meeting-notes-kit/ai.agent-connector.ave/prompts/meeting-notes.md", "No frontmatter.\n");
    r.commit("invalid prompt");
    assert.match(r.tool("index.mjs", "--check").stderr, /agent-plugins\/meeting-notes-kit: ai\.agent-connector\.ave\/prompts\/meeting-notes\.md/u);
  });

  it("drops a published package only when tools/withdrawn.json withdraws it", () => {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    r.write("skills/review/ave-package.json", skill("1.0.0"));
    r.write("skills/review/SKILL.md", "---\nname: review\ndescription: Review.\n---\nBody.\n");
    r.commit("alpha and review");
    assert.equal(r.tool("index.mjs").status, 0);
    const published = r.commit("index");
    r.git("rm", "-rq", "plugins/alpha");
    r.commit("remove alpha");
    assert.match(r.tool("index.mjs", "--check").stderr, /plugin\/alpha: published package is missing; withdraw it in tools\/withdrawn\.json/u);

    r.write("tools/withdrawn.json", { withdrawn: [{ kind: "plugin", name: "alpha", reason: "Moved elsewhere." }] });
    r.commit("withdraw alpha");
    assert.equal(r.tool("index.mjs").status, 0);
    assert.deepEqual(r.index().packages.map((entry) => entry.name), ["review"]);
    r.commit("index without alpha");
    assert.equal(r.tool("index.mjs", "--check").status, 0);
    const check = r.tool("check.mjs", "--base", published);
    assert.equal(check.status, 0, check.stderr);

    r.write("tools/withdrawn.json", { withdrawn: [{ kind: "skill", name: "review", reason: "Still here." }] });
    assert.match(r.tool("index.mjs", "--check").stderr, /skill\/review: withdrawn in tools\/withdrawn\.json but its package is still here/u);
    assert.match(r.tool("check.mjs", "--base", published).stderr, /plugin\/alpha@1\.0\.0: a published version cannot leave the index/u);
    r.write("tools/withdrawn.json", { withdrawn: [{ kind: "plugin", name: "alpha" }] });
    assert.match(r.tool("index.mjs", "--check").stderr, /every entry needs kind, name and reason/u);
  });

  it("keeps published versions across the descriptor schemaVersion 1 to 2 migration", () => {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    r.write("skills/review/SKILL.md", "---\nname: review\ndescription: Review.\n---\nBody.\n");
    // Both descriptors were published at schemaVersion 1.
    r.write("plugins/alpha/ave-package.json", { ...plugin("1.0.0"), schemaVersion: 1 });
    r.write("skills/review/ave-package.json", { ...skill("1.0.0"), schemaVersion: 1 });
    const published = r.commit("published at schemaVersion 1");
    const publishedAt = new Date(Number(r.git("log", "-1", "--format=%ct", published).trim()) * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
    r.write("marketplace.json", {
      schemaVersion: 2, name: "ave", displayName: "Ave Official",
      packages: [
        { kind: "plugin", name: "alpha", path: "plugins/alpha", latest: "1.0.0",
          versions: [{ version: "1.0.0", commit: published, minAppVersion: "0.10.0", authority: AUTHORITY, artifact: plugin("1.0.0").payload.artifact, publishedAt }] },
        { kind: "skill", name: "review", path: "skills/review", latest: "1.0.0",
          versions: [{ version: "1.0.0", commit: published, minAppVersion: "0.10.0", publishedAt }] },
      ],
    });
    const indexed = r.commit("index");
    r.write("plugins/alpha/ave-package.json", plugin("1.0.0"));
    r.write("skills/review/ave-package.json", skill("1.0.0"));
    r.commit("migrate the descriptors to schemaVersion 2");
    const migrated = r.tool("index.mjs", "--check");
    assert.equal(migrated.status, 0, migrated.stderr);
    const check = r.tool("check.mjs", "--base", indexed);
    assert.equal(check.status, 0, check.stderr);

    r.write("skills/review/ave-package.json", { ...skill("1.0.0"), minAppVersion: "0.11.0" });
    r.commit("change review without a version");
    assert.match(r.tool("index.mjs", "--check").stderr, /skill\/review: skills\/review changed after 1\.0\.0 was published at .*; raise the version/u);

    r.write("skills/review/ave-package.json", skill("1.0.0"));
    r.write("plugins/alpha/ave-package.json", plugin("1.0.0", "c".repeat(64)));
    r.commit("change alpha without a version");
    assert.match(r.tool("index.mjs", "--check").stderr, /plugin\/alpha: plugins\/alpha changed after 1\.0\.0 was published/u);
  });

  it("lists a new version at the last commit that changed the package", () => {
    const r = repo();
    r.write("skills/review/ave-package.json", skill("1.0.0"));
    r.write("skills/review/SKILL.md", "---\nname: review\ndescription: Review.\n---\nBody.\n");
    const published = r.commit("add review");
    assert.equal(r.tool("index.mjs").status, 0);
    const [entry] = r.index().packages;
    assert.equal(entry.latest, "1.0.0");
    assert.equal(entry.versions[0].commit, published);
    r.commit("index");
    assert.equal(r.tool("index.mjs", "--check").status, 0);
  });

  it("keeps published versions, adds the next one first, and pins a plugin version to its descriptor", () => {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    const first = r.commit("alpha 1.0.0");
    r.tool("index.mjs");
    r.commit("index");
    r.write("plugins/alpha/source/src.ts", "export {};\n");
    r.commit("source change without a release");
    assert.equal(r.tool("index.mjs", "--check").status, 0, "a source change alone publishes nothing");
    r.write("plugins/alpha/ave-package.json", plugin("1.1.0", "c".repeat(64)));
    const second = r.commit("pin alpha 1.1.0");
    assert.equal(r.tool("index.mjs").status, 0);
    const versions = r.index().packages[0].versions;
    assert.deepEqual(versions.map((v) => [v.version, v.commit]), [["1.1.0", second], ["1.0.0", first]]);
    assert.equal(versions[0].artifact.release.sha256, "c".repeat(64));
  });

  it("indexes protocol 2 and its sandbox in the one schemaVersion 2 catalog", () => {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    r.commit("pre-protocol plugin");
    assert.equal(r.tool("index.mjs").status, 0);
    r.commit("index");

    const next = plugin("1.1.0");
    next.minAppVersion = "0.12.0";
    next.hostProtocol = "2";
    next.payload.authority = {
      ...AUTHORITY,
      requires: { minAppVersion: "0.12.0", hostProtocol: "2" },
      sandbox: { write: [{ kind: "userChosenDirectory", configKey: "workspace", why: "worker state" }] },
    };
    r.write("plugins/alpha/ave-package.json", next);
    r.commit("protocol 2 pin");
    assert.equal(r.tool("index.mjs").status, 0);
    assert.equal(r.index().schemaVersion, 2);
    assert.deepEqual(r.index().packages[0].versions.map((v) => v.version), ["1.1.0", "1.0.0"]);
    assert.equal(r.index().packages[0].versions[0].hostProtocol, "2");
    assert.deepEqual(r.index().packages[0].versions[0].authority.sandbox, next.payload.authority.sandbox);
  });

  it("refuses a changed package without a version bump, a lower version, and an uncommitted package", () => {
    const r = repo();
    r.write("skills/review/ave-package.json", skill("1.0.0"));
    r.write("skills/review/SKILL.md", "v1\n");
    r.commit("v1");
    r.tool("index.mjs");
    r.commit("index");
    r.write("skills/review/SKILL.md", "v2\n");
    r.commit("edit without bump");
    assert.match(r.tool("index.mjs").stderr, /changed after 1\.0\.0 was published .*raise the version/u);
    r.write("skills/review/ave-package.json", skill("0.9.0"));
    r.commit("lower");
    assert.match(r.tool("index.mjs").stderr, /0\.9\.0 must exceed every listed version \(1\.0\.0\)/u);
    r.write("skills/review/ave-package.json", skill("1.1.0"));
    assert.match(r.tool("index.mjs").stderr, /commit skills\/review before generating the index/u);
  });

  it("refuses an uncommitted edit to a listed descriptor", () => {
    const r = repo();
    r.write("skills/review/ave-package.json", skill("1.0.0"));
    r.write("skills/review/SKILL.md", "body\n");
    r.commit("publish review");
    assert.equal(r.tool("index.mjs").status, 0);
    r.commit("index review");
    r.write("skills/review/ave-package.json", { ...skill("1.0.0"), displayName: "Changed without a version" });
    assert.match(r.tool("index.mjs", "--check").stderr, /changed after 1\.0\.0 was published .*raise the version/u);
  });

  it("refuses to drop a package with published versions", () => {
    const r = repo();
    r.write("skills/review/ave-package.json", skill("1.0.0"));
    r.write("skills/review/SKILL.md", "body\n");
    r.commit("publish review");
    assert.equal(r.tool("index.mjs").status, 0);
    r.commit("index review");
    r.git("rm", "-r", "skills/review");
    r.commit("remove review");
    assert.match(r.tool("index.mjs", "--check").stderr, /skill\/review: published package is missing/u);
  });

  it("holds every kept entry to the commit it names", () => {
    const r = repo();
    r.write("plugins/alpha/ave-package.json", plugin("1.0.0"));
    r.commit("alpha 1.0.0");
    r.tool("index.mjs");
    r.commit("index");
    const index = r.index();
    const kept = index.packages[0].versions[0];
    // A hand-added lower version with another sha256 and wider authority.
    index.packages[0].versions.push({ ...kept, version: "0.9.9", authority: { capabilities: ["shell"], requires: AUTHORITY.requires } });
    r.write("marketplace.json", index);
    assert.match(r.tool("index.mjs", "--check").stderr, /plugin\/alpha@0\.9\.9: version, authority differ from plugins\/alpha\/ave-package\.json at /u);
    index.packages[0].versions.pop();
    // A pin commit squashed away: the entry names a commit HEAD's history does not hold.
    r.git("checkout", "-q", "-b", "side");
    r.write("plugins/alpha/ave-package.json", plugin("1.1.0"));
    const pinned = r.commit("pin alpha 1.1.0 on a branch");
    r.git("checkout", "-q", "main");
    index.packages[0].versions.unshift({ ...kept, version: "1.1.0", commit: pinned });
    r.write("marketplace.json", index);
    assert.match(r.tool("index.mjs", "--check").stderr, /plugin\/alpha@1\.1\.0: [0-9a-f]{40} is not in this branch's history; merge pull requests with a merge commit/u);
  });
});

describe("repository check", () => {
  function published() {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    r.commit("alpha");
    r.tool("index.mjs");
    const base = r.commit("index");
    return { r, base };
  }

  it("accepts a published official plugin", () => {
    const { r, base } = published();
    const result = r.tool("check.mjs", "--base", base);
    assert.equal(result.status, 0, result.stderr);
  });

  it("refuses a catalog at a schemaVersion the app does not read", () => {
    const r = repo();
    r.write("marketplace.json", { schemaVersion: 3, name: "ave", displayName: "Ave Official", packages: [] });
    const result = r.tool("check.mjs");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^marketplace\.json: schemaVersion 3; the app reads schemaVersion 2$/mu);
  });

  it("holds published versions to a base from before the catalog moved to marketplace.json", () => {
    const { r } = published();
    // The pre-move layout: format 2 at marketplace.2.json beside a format-1
    // marketplace.json. The format-1 file lists nothing here, so every
    // published version below is known only through marketplace.2.json.
    const current = r.index();
    r.write("marketplace.2.json", current);
    r.write("marketplace.json", { ...current, schemaVersion: 1, packages: [] });
    const base = r.commit("pre-move layout");
    rmSync(join(r.root, "marketplace.2.json"));
    r.write("marketplace.json", current);
    r.commit("move the catalog");
    const immutability = r.tool("check.mjs", "--base", base).stderr.split("\n").filter((line) => / (?:cannot leave the index|changed after publication)/u.test(line));
    assert.deepEqual(immutability, []);
    const listed = r.call("release.mjs", `m.newPluginVersions(${JSON.stringify(base)})`);
    assert.deepEqual(listed, []);

    const dropped = { ...current, packages: [] };
    r.write("marketplace.json", dropped);
    assert.match(r.tool("check.mjs", "--base", base).stderr, /a published version cannot leave the index/u);
  });

  it("keeps the Korean pack within the current English interface catalog", () => {
    const messages = JSON.parse(readFileSync(join(REAL_ROOT, "languages/korean/messages.json"), "utf8"));
    assert.equal(Object.hasOwn(messages, "overlayCard.pluginNotice"), false);
    assert.equal(messages["alerts.pluginIdOnly"], "익스텐션: {id}");
    const languageProblems = checkMarketplaceRepository(workingTree(), { sourceId: "ave", official: true, alertsReleaseVersion: "0.11.0", releasedManifests: new Map() })
      .filter((problem) => problem.subject === "language/korean");
    assert.deepEqual(languageProblems, []);
  });

  it("keeps released Ave 0.14.0 users on Korean 1.0.5", () => {
    const index = JSON.parse(readFileSync(join(REAL_ROOT, "marketplace.json"), "utf8"));
    const korean = index.packages.find((entry) => entry.kind === "language" && entry.name === "korean");
    for (const version of ["1.0.6", "1.0.7"]) {
      const pin = korean.versions.find((entry) => entry.version === version);
      assert.equal(pin.minAppVersion, "0.14.2");
      const descriptor = JSON.parse(execFileSync("git", ["show", `${pin.commit}:languages/korean/ave-package.json`], { cwd: REAL_ROOT, encoding: "utf8" }));
      assert.equal(descriptor.version, version);
      assert.equal(descriptor.minAppVersion, pin.minAppVersion);
      assert.equal(descriptor.description, "Korean interface translation for Ave 0.14.2 and later.");
    }
    for (const [appVersion, expected] of [["0.14.0", "1.0.5"], ["0.14.1", "1.0.5"], ["0.14.2", "1.0.7"]]) {
      const eligible = korean.versions.filter((pin) => !pin.yanked && compareVersions(appVersion, pin.minAppVersion) >= 0)
        .sort((a, b) => compareVersions(b.version, a.version));
      assert.equal(eligible[0].version, expected);
    }
  });

  it("requires protocol 2 in 0.12 source, descriptor, index, and released manifest", () => {
    const { r, base } = published();
    const manifestPath = "plugins/alpha/source/plugin.json";
    const manifest = JSON.parse(readFileSync(join(r.root, manifestPath), "utf8"));
    manifest.extensions["ai.agent-connector.ave"].requires.minAppVersion = "0.12.0";
    r.write(manifestPath, manifest);
    assert.match(r.tool("check.mjs").stderr, /requires\.hostProtocol must be 2 for minAppVersion 0\.12\.0/u);

    manifest.extensions["ai.agent-connector.ave"].requires.hostProtocol = "2";
    r.write(manifestPath, manifest);
    const descriptorPath = "plugins/alpha/ave-package.json";
    const descriptor = plugin("1.0.0");
    descriptor.minAppVersion = "0.12.0";
    descriptor.payload.authority = structuredClone(descriptor.payload.authority);
    descriptor.payload.authority.requires = { minAppVersion: "0.12.0", hostProtocol: "2" };
    r.write(descriptorPath, descriptor);
    assert.match(r.tool("check.mjs").stderr, /plugins\/alpha\/ave-package\.json: hostProtocol 2 is required/u);

    descriptor.hostProtocol = "2";
    r.write(descriptorPath, descriptor);
    const index = r.index();
    index.packages[0].versions[0].minAppVersion = "0.12.0";
    r.write("marketplace.json", index);
    assert.match(r.tool("check.mjs").stderr, /marketplace\.json requires hostProtocol 2 for minAppVersion 0\.12\.0/u);

    index.packages[0].versions[0].hostProtocol = "2";
    r.write("marketplace.json", index);
    const released = join(r.root, "released-no-protocol.json");
    writeFileSync(released, JSON.stringify({ ...manifest, extensions: { "ai.agent-connector.ave": { ...manifest.extensions["ai.agent-connector.ave"], requires: { minAppVersion: "0.12.0" } } } }));
    assert.match(r.tool("check.mjs", "--base", base, "--released", `alpha@1.0.0=${released}`).stderr, /released plugin\.json requires hostProtocol 2/u);
  });

  it("requires protocol 3 from app 0.14.0 and keeps protocol 2 below it", () => {
    const { r } = published();
    const manifestPath = "plugins/alpha/source/plugin.json";
    const manifest = JSON.parse(readFileSync(join(r.root, manifestPath), "utf8"));
    manifest.extensions["ai.agent-connector.ave"].requires = { minAppVersion: "0.14.0", hostProtocol: "2" };
    r.write(manifestPath, manifest);
    assert.match(r.tool("check.mjs").stderr, /requires\.hostProtocol must be 3 for minAppVersion 0\.14\.0/u);

    manifest.extensions["ai.agent-connector.ave"].requires = { minAppVersion: "0.13.0", hostProtocol: "3" };
    r.write(manifestPath, manifest);
    assert.match(r.tool("check.mjs").stderr, /requires\.hostProtocol must be 2 for minAppVersion 0\.13\.0/u);

    manifest.extensions["ai.agent-connector.ave"].requires = { minAppVersion: "0.14.0", hostProtocol: "3" };
    r.write(manifestPath, manifest);
    assert.doesNotMatch(r.tool("check.mjs").stderr, /hostProtocol/u);
  });

  it("requires protocol 5 from Ave 0.14.2", () => {
    const { r } = published();
    const manifestPath = "plugins/alpha/source/plugin.json";
    const manifest = JSON.parse(readFileSync(join(r.root, manifestPath), "utf8"));
    manifest.extensions["ai.agent-connector.ave"].requires = { minAppVersion: "0.14.2", hostProtocol: "3" };
    r.write(manifestPath, manifest);
    assert.match(r.tool("check.mjs").stderr, /requires\.hostProtocol must be 5 for minAppVersion 0\.14\.2/u);
    manifest.extensions["ai.agent-connector.ave"].requires.hostProtocol = "5";
    r.write(manifestPath, manifest);
    assert.doesNotMatch(r.tool("check.mjs").stderr, /hostProtocol/u);
  });

  it("fails when the base commit is not in the clone instead of skipping the comparison", () => {
    const { r } = published();
    assert.match(r.tool("check.mjs", "--base", "0123456789abcdef0123456789abcdef01234567").stderr, /the base commit is not in this clone/u);
  });

  it("refuses edits to a published version except yanked and rollout", () => {
    const { r, base } = published();
    const index = r.index();
    index.packages[0].versions[0].rollout = { percent: 50 };
    r.write("marketplace.json", index);
    assert.equal(r.tool("check.mjs", "--base", base).status, 0);
    index.packages[0].versions[0].artifact.release.sha256 = "d".repeat(64);
    r.write("marketplace.json", index);
    assert.match(r.tool("check.mjs", "--base", base).stderr, /plugin\/alpha@1\.0\.0: artifact changed after publication/u);
    index.packages = [];
    r.write("marketplace.json", index);
    assert.match(r.tool("check.mjs", "--base", base).stderr, /cannot leave the index; yank it instead/u);
  });

  it("holds official plugins to release assets built from this repository", () => {
    const { r } = published();
    r.write("plugins/alpha/plugin.json", { name: "alpha" });
    r.write("plugins/alpha/source/package.json", { name: "@ave/plugin-alpha", version: "1.0.1" });
    r.git("add", "-A");
    const { stderr } = r.tool("check.mjs");
    assert.match(stderr, /an official plugin ships as a release asset only/u);
    assert.match(stderr, /plugin\.json 1\.0\.0 and package\.json 1\.0\.1 must carry one version/u);
  });

  it("refuses a manifest the app refuses, a misplaced package and a credential", () => {
    const { r } = published();
    const manifest = JSON.parse(readFileSync(join(r.root, "plugins/alpha/source/plugin.json"), "utf8"));
    manifest.extensions["ai.agent-connector.ave"].installPolicy = "admin";
    r.write("plugins/alpha/source/plugin.json", manifest);
    r.write("agents/review/ave-package.json", skill("1.0.0"));
    r.write("agents/review/SKILL.md", "body\n");
    r.write("notes.txt", `token ghp_${"a".repeat(36)}\n`);
    r.git("add", "-A");
    const { stderr } = r.tool("check.mjs");
    assert.match(stderr, /carries installPolicy, which the app refuses/u);
    assert.match(stderr, /agents\/review: a skill package does not belong in agents\//u);
    assert.match(stderr, /notes\.txt: looks like it contains a GitHub token/u);
  });

  it("rejects legacy notificationEvents in a new source before release pinning", () => {
    const { r } = published();
    const path = "plugins/alpha/source/plugin.json";
    const manifest = JSON.parse(readFileSync(join(r.root, path), "utf8"));
    manifest.version = "1.1.0";
    manifest.extensions["ai.agent-connector.ave"].requires.minAppVersion = "0.12.0";
    manifest.extensions["ai.agent-connector.ave"].notificationEvents = [{ event: "index.done", titleField: "title" }];
    r.write(path, manifest);
    r.write("plugins/alpha/source/package.json", { name: "@ave/plugin-alpha", version: "1.1.0" });
    r.git("add", "-A");
    assert.match(r.tool("check.mjs").stderr, /carries notificationEvents at or above app 0\.11\.0/u);
  });

  it("checks existence without imposing an integrity gate", () => {
    const r = repo();
    r.write("contract/public-contract.ts", "// local copy\n");
    assert.equal(r.tool("vendor.mjs", "check").status, 0);
    rmSync(join(r.root, "contract/public-contract.ts"));
    assert.match(r.tool("vendor.mjs", "check").stderr, /contract\/public-contract\.ts: missing/u);
  });

  it("includes the renamed extension template in the CI package matrix", () => {
    const workflow = readFileSync(join(REAL_ROOT, ".github/workflows/validate.yml"), "utf8");
    assert.match(workflow, /git ls-files 'plugins\/\*\/source\/plugin\.json' 'templates\/extension\/plugin\.json'/u);
  });

  it("checks the conditional revocation file against the host schema", () => {
    const { r } = published();
    const file = {
      schemaVersion: 1,
      revocations: [{
        kind: "plugin",
        name: "alpha",
        versions: "*",
        appVersions: "0.11.0",
        reason: "Superseded.",
        at: "2026-10-01T00:00:00Z",
        action: "uninstall",
        successors: { plugins: [{ pluginId: "beta" }], hostKinds: [] },
      }],
    };
    r.write("policy/revocations-by-app.json", file);
    r.git("add", "-A");
    const accepted = r.tool("check.mjs");
    assert.equal(accepted.status, 0, accepted.stderr);
    delete file.revocations[0].appVersions;
    r.write("policy/revocations-by-app.json", file);
    assert.match(r.tool("check.mjs").stderr, /revocations-by-app\.json.*appVersions/u);
  });

  it("rejects notificationEvents at the alerts release in a released manifest", () => {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    const descriptor = plugin("1.0.0");
    descriptor.payload.authority = structuredClone(descriptor.payload.authority);
    descriptor.minAppVersion = "0.11.0";
    descriptor.payload.authority.requires.minAppVersion = "0.11.0";
    r.write("plugins/alpha/ave-package.json", descriptor);
    const manifest = JSON.parse(readFileSync(join(r.root, "plugins/alpha/source/plugin.json"), "utf8"));
    manifest.extensions["ai.agent-connector.ave"].requires.minAppVersion = "0.11.0";
    manifest.extensions["ai.agent-connector.ave"].notificationEvents = [];
    r.write("plugins/alpha/source/plugin.json", manifest);
    r.commit("alerts version");
    assert.equal(r.tool("index.mjs").status, 0);
    r.commit("index");
    const released = join(r.root, "released.json");
    r.write("released.json", manifest);
    assert.match(r.tool("check.mjs", "--released", `alpha@1.0.0=${released}`).stderr, /notificationEvents is retired/u);
  });
});

describe("releases", () => {
  function built(r, version = "1.0.0") {
    withSourcePlugin(r, version);
    r.write("plugins/alpha/source/package.json", { name: "@ave/plugin-alpha", version, files: ["dist"] });
    r.write("plugins/alpha/source/dist/hostPlugin.js", "export default () => ({});\n");
    r.write("plugins/alpha/source/dist/hostPlugin.js.map", "{}\n");
    r.write("plugins/alpha/source/dist/node_modules/x/index.js", "\n");
    r.write("plugins/alpha/source/src/index.ts", "export {};\n");
  }
  const entries = (zip) => execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean).sort();

  it("rejects MARKETPLACE_ROOT on every publication command", () => {
    const r = repo();
    assert.equal(r.publishTool("release.mjs", "plan", "--publish").status, 0);
    for (const args of [["plan", "--publish"], ["pin", "alpha", "/missing.zip"], ["verify", "--publish"]]) {
      assert.match(r.tool("release.mjs", ...args).stderr, /MARKETPLACE_ROOT is for tests only/u);
    }
  });

  it("fails the release plan step when its checker command fails", () => {
    const workflow = readFileSync(join(REAL_ROOT, ".github/workflows/release.yml"), "utf8");
    const match = workflow.match(/^      - id: plan\n        run: \|\n((?:          [^\n]*\n)+)/mu);
    assert.ok(match, "release plan must be a checked multiline shell step");
    const script = match[1].replace(/^          /gmu, "");
    const fake = realpathSync(mkdtempSync(join(tmpdir(), "marketplace-failing-node-")));
    scratch.push(fake);
    writeFileSync(join(fake, "node"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    const run = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      cwd: REAL_ROOT,
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, GITHUB_OUTPUT: join(fake, "output") },
      encoding: "utf8",
    });
    assert.equal(run.status, 42, run.stderr);
  });

  it("plans every source version without a tag, and checks a plugin before its first release", () => {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    r.git("rm", "-q", "--cached", "--ignore-unmatch", "plugins/alpha/ave-package.json");
    rmSync(join(r.root, "plugins/alpha/ave-package.json"));
    r.commit("alpha source");
    const plan = () => JSON.parse(r.tool("release.mjs", "plan").stdout);
    assert.deepEqual(plan(), [{ name: "alpha", version: "1.0.0", tag: "alpha-v1.0.0", asset: "alpha-1.0.0.zip" }]);
    r.git("tag", "alpha-v1.0.0");
    assert.deepEqual(plan(), []);

    const manifest = JSON.parse(readFileSync(join(r.root, "plugins/alpha/source/plugin.json"), "utf8"));
    delete manifest.extensions["ai.agent-connector.ave"].capabilities;
    r.write("plugins/alpha/source/plugin.json", manifest);
    r.git("add", "-A");
    assert.match(r.tool("check.mjs").stderr, /plugin\/alpha: .*capabilities must be declared/u);
  });

  it("packs plugin.json and files[] only, and refuses what must not ship", () => {
    const r = repo();
    built(r);
    r.commit("alpha");
    const zip = join(r.root, "..", `${r.root.split("/").pop()}-pack.zip`);
    scratch.push(zip);
    assert.equal(r.tool("release.mjs", "pack", "alpha", zip).status, 0);
    assert.deepEqual(entries(zip), ["dist/", "dist/hostPlugin.js", "plugin.json"]);

    for (const [files, message] of [
      [["dist/*.js"], /takes paths, not globs/u],
      [["../other"], /escapes the plugin directory/u],
      [[".env"], /matches a credential file pattern/u],
      [["lib"], /declared but missing; build first/u],
    ]) {
      r.write("plugins/alpha/source/package.json", { name: "@ave/plugin-alpha", version: "1.0.0", files });
      assert.match(r.tool("release.mjs", "pack", "alpha", zip).stderr, message);
    }
    r.write("plugins/alpha/source/package.json", { name: "@ave/plugin-alpha", version: "1.0.0", files: ["dist"] });
    symlinkSync("hostPlugin.js", join(r.root, "plugins/alpha/source/dist/link.js"));
    assert.match(r.tool("release.mjs", "pack", "alpha", zip).stderr, /dist\/link\.js is a symbolic link/u);
    rmSync(join(r.root, "plugins/alpha/source/dist/link.js"));
    // A build step that rewrites the manifest cannot ship it.
    const manifest = JSON.parse(readFileSync(join(r.root, "plugins/alpha/source/plugin.json"), "utf8"));
    manifest.extensions["ai.agent-connector.ave"].capabilities = ["shell"];
    r.write("plugins/alpha/source/plugin.json", manifest);
    assert.match(r.tool("release.mjs", "pack", "alpha", zip).stderr, /plugin\.json differs from the commit; a build step changed it/u);
  });

  it("holds a released manifest to the source committed at its tag, on this branch", () => {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    r.commit("alpha");
    r.git("tag", "alpha-v1.0.0");
    const source = JSON.parse(readFileSync(join(r.root, "plugins/alpha/source/plugin.json"), "utf8"));
    const mismatches = (manifest, tag = "alpha-v1.0.0") =>
      r.call("release.mjs", `m.sourceMismatches("alpha", "1.0.0", ${JSON.stringify(tag)}, ${JSON.stringify(manifest)})`);
    assert.deepEqual(mismatches(source), []);
    const widened = structuredClone(source);
    widened.extensions["ai.agent-connector.ave"].hostSecrets = { read: ["llm.apiKey.openai"] };
    assert.deepEqual(mismatches(widened), ["its authority or minAppVersion differs from the source committed at alpha-v1.0.0"]);
    r.git("checkout", "-q", "-b", "side");
    r.write("plugins/alpha/source/README.md", "side\n");
    r.commit("side");
    r.git("tag", "alpha-v1.0.0-side");
    r.git("checkout", "-q", "main");
    assert.match(mismatches(source, "alpha-v1.0.0-side")[0], /which is not in this branch's history/u);
    assert.deepEqual(mismatches(source, "alpha-v9.9.9"), ["the tag alpha-v9.9.9 is not in this clone"]);
  });

  it("pins a released zip into a descriptor the app accepts, and refuses a zip that disagrees with it", () => {
    const r = repo();
    built(r);
    rmSync(join(r.root, "plugins/alpha/ave-package.json"));
    r.commit("alpha source");
    const zip = join(r.root, "..", `${r.root.split("/").pop()}-alpha.zip`);
    scratch.push(zip);
    const sha256 = r.tool("release.mjs", "pack", "alpha", zip).stdout.trim();
    assert.equal(r.publishTool("release.mjs", "pin", "alpha", zip).status, 0);
    const descriptor = JSON.parse(readFileSync(join(r.root, "plugins/alpha/ave-package.json"), "utf8"));
    assert.deepEqual(descriptor.payload, {
      authority: AUTHORITY,
      artifact: { release: { repo: "ken-jo/agent-marketplace", tag: "alpha-v1.0.0", asset: "alpha-1.0.0.zip", sha256 } },
    });
    const base = r.commit("pin alpha");
    assert.equal(r.tool("index.mjs").status, 0);
    r.commit("index");

    const released = join(r.root, "..", `${r.root.split("/").pop()}-released.json`);
    scratch.push(released);
    writeFileSync(released, execFileSync("unzip", ["-p", zip, "plugin.json"]));
    const check = () => r.tool("check.mjs", "--base", base, "--released", `alpha@1.0.0=${released}`);
    assert.equal(check().status, 0, check().stderr);
    const manifest = JSON.parse(readFileSync(released, "utf8"));
    manifest.extensions["ai.agent-connector.ave"].capabilities = ["network"];
    writeFileSync(released, JSON.stringify(manifest));
    assert.match(check().stderr, /the released plugin\.json of 1\.0\.0: capabilities differs from the descriptor's authority/u);
  });

  /** Run `expression` against `r` with release.mjs as `m`, keeping stdout and stderr apart. */
  const releaseCall = (r, expression) => r.evaluate("release.mjs", `console.log(JSON.stringify(await (${expression})));`);

  it("lists new versions against a base without a catalog quietly, and refuses a base that is not a commit", () => {
    const r = repo();
    rmSync(join(r.root, "marketplace.json"));
    const base = r.commit("before the format-2 catalog");
    r.git("update-ref", "refs/remotes/origin/main", base);
    r.write("marketplace.json", { schemaVersion: 2, name: "ave", displayName: "Ave Official", packages: [] });
    withSourcePlugin(r, "1.0.0");
    r.commit("alpha");
    assert.equal(r.tool("index.mjs").status, 0);
    r.commit("index");

    const listed = releaseCall(r, `m.newPluginVersions("origin/main").map((v) => \`\${v.name}@\${v.version}\`)`);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), ["alpha@1.0.0"]);
    // git's "fatal: path 'marketplace.json' does not exist" for a result that is fine.
    assert.equal(listed.stderr, "");

    const planned = r.publishTool("release.mjs", "plan", "--publish");
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(planned.stderr, "");
    assert.deepEqual(JSON.parse(planned.stdout), [{ name: "alpha", version: "1.0.0", tag: "alpha-v1.0.0", asset: "alpha-1.0.0.zip" }]);

    const missing = releaseCall(r, `m.newPluginVersions("0".repeat(40))`);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /base 0{40} is not a commit in this clone/u);
  });

  it("keeps a real git failure loud instead of treating it as an absent catalog", () => {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    const base = r.commit("alpha");
    assert.equal(r.tool("index.mjs").status, 0);
    r.commit("index");

    // The commit still exists, but its tree cannot be read. This is a real
    // git failure, independent of the missing-path diagnostic above.
    const tree = r.git("rev-parse", `${base}^{tree}`).trim();
    rmSync(join(r.root, ".git/objects", tree.slice(0, 2), tree.slice(2)));
    const broken = releaseCall(r, `m.newPluginVersions(${JSON.stringify(base)})`);
    assert.notEqual(broken.status, 0);
    assert.notEqual(broken.stderr, "");
    assert.match(broken.stderr, /fatal: (?:not a tree object|bad tree object|unable to read tree)/u);
    assert.equal(broken.stdout, "");
  });

  it("rejects an invalid catalog at the base instead of counting everything as new", () => {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    r.write("marketplace.json", "{not json\n");
    const base = r.commit("invalid catalog");
    r.write("marketplace.json", { schemaVersion: 2, name: "ave", displayName: "Ave Official", packages: [] });
    assert.equal(r.tool("index.mjs").status, 0);
    r.commit("index");

    const invalid = releaseCall(r, `m.newPluginVersions(${JSON.stringify(base)})`);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /SyntaxError/u);
    assert.equal(invalid.stdout, "");
  });

  /**
   * alpha@1.0.0 published for app 0.11.0, the alerts release: its plugin.json
   * lives only in the release asset, and the repository check holds it there.
   * `zip` is that asset; the descriptor pins its sha256.
   */
  function publishedAtAlertsRelease() {
    const r = repo();
    withSourcePlugin(r, "1.0.0");
    const manifest = JSON.parse(readFileSync(join(r.root, "plugins/alpha/source/plugin.json"), "utf8"));
    manifest.extensions["ai.agent-connector.ave"].requires = { minAppVersion: "0.11.0" };
    r.write("plugins/alpha/source/plugin.json", manifest);
    const asset = realpathSync(mkdtempSync(join(tmpdir(), "marketplace-asset-")));
    scratch.push(asset);
    writeFileSync(join(asset, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync("zip", ["-q", "-X", "alpha-1.0.0.zip", "plugin.json"], { cwd: asset });
    const zip = join(asset, "alpha-1.0.0.zip");
    const descriptor = plugin("1.0.0", createHash("sha256").update(readFileSync(zip)).digest("hex"));
    descriptor.minAppVersion = "0.11.0";
    descriptor.payload.authority = { ...AUTHORITY, requires: { minAppVersion: "0.11.0" } };
    r.write("plugins/alpha/ave-package.json", descriptor);
    r.commit("alpha");
    r.git("tag", "alpha-v1.0.0");
    assert.equal(r.tool("index.mjs").status, 0);
    const base = r.commit("index");
    return { r, zip, base };
  }

  it("hands the check the released plugin.json of each plugin's current version, not only of new ones", () => {
    const { r, zip, base } = publishedAtAlertsRelease();
    // Nothing is new against `base` itself: a pull request that touches no
    // descriptor. The check still needs alpha@1.0.0's released plugin.json.
    const download = `(release, dir) => { globalThis.downloads = [...(globalThis.downloads ?? []), release.tag]; `
      + `const fs = process.getBuiltinModule("node:fs"); fs.mkdirSync(dir, { recursive: true }); `
      + `fs.copyFileSync(${JSON.stringify(zip)}, dir + "/" + release.asset); }`;
    const result = releaseCall(r, `({ problems: m.verify(${JSON.stringify(base)}, { download: ${download} }), downloads: globalThis.downloads ?? [] })`);
    assert.equal(result.status, 0, result.stderr);
    const { problems, downloads } = JSON.parse(result.stdout);
    assert.deepEqual(problems, []);
    assert.deepEqual(downloads, ["alpha-v1.0.0"]);
  });

  /** A download that fails its first `failures` attempts, then copies `zip`; attempts are counted. */
  const flakyDownload = (zip, failures) => `(release, dir) => { globalThis.attempts = (globalThis.attempts ?? 0) + 1; `
    + `if (globalThis.attempts <= ${failures}) throw new Error("HTTP 502: release-assets unavailable"); `
    + `const fs = process.getBuiltinModule("node:fs"); fs.mkdirSync(dir, { recursive: true }); `
    + `fs.copyFileSync(${JSON.stringify(zip)}, dir + "/" + release.asset); }`;

  it("retries a failed release download with backoff before giving up", () => {
    const { r, zip, base } = publishedAtAlertsRelease();
    const result = releaseCall(r, `({ problems: m.verify(${JSON.stringify(base)}, { download: ${flakyDownload(zip, 2)}, retryDelaysMs: [0, 0] }), attempts: globalThis.attempts })`);
    assert.equal(result.status, 0, result.stderr);
    const { problems, attempts } = JSON.parse(result.stdout);
    assert.deepEqual(problems, []);
    assert.equal(attempts, 3);
  });

  it("names the asset when its download keeps failing, instead of throwing", () => {
    const { r, zip, base } = publishedAtAlertsRelease();
    const result = releaseCall(r, `({ problems: m.verify(${JSON.stringify(base)}, { download: ${flakyDownload(zip, 99)}, retryDelaysMs: [0, 0] }), attempts: globalThis.attempts })`);
    assert.equal(result.status, 0, result.stderr);
    const { problems, attempts } = JSON.parse(result.stdout);
    assert.equal(attempts, 3);
    const failed = problems.filter((problem) => !/Supply releasedManifests/u.test(problem));
    assert.deepEqual(failed, [
      "plugin/alpha@1.0.0: could not download ken-jo/agent-marketplace alpha-v1.0.0/alpha-1.0.0.zip after 3 attempts: HTTP 502: release-assets unavailable",
    ]);
  });

  it("says to run release.mjs verify when check.mjs alone lacks a released plugin.json", () => {
    const { r } = publishedAtAlertsRelease();
    const alone = r.tool("check.mjs");
    assert.equal(alone.status, 1);
    assert.equal(alone.stdout, "");
    assert.match(alone.stderr, /alpha@1\.0\.0/u);
    assert.match(alone.stderr, /Run `node tools\/release\.mjs verify`/u);
    assert.match(alone.stderr, /--released <plugin>@<version>=<plugin\.json path>/u);
    assert.doesNotMatch(alone.stderr, /Supply releasedManifests|--base <ref>/u);
  });

  it("accepts supplied release manifests without downloading releases and preserves the base in its recovery command", () => {
    const { r, zip, base } = publishedAtAlertsRelease();
    const missing = r.tool("check.mjs", "--base", base);
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes(`Run \`node tools/release.mjs verify --base '${base}'\``));

    const ref = "refs/heads/release'branch$";
    r.git("update-ref", ref, base);
    const quoted = r.tool("check.mjs", "--base", ref);
    assert.ok(quoted.stderr.includes("Run `node tools/release.mjs verify --base 'refs/heads/release'\\''branch$'`"));

    const manifest = join(r.root, "released.json");
    writeFileSync(manifest, execFileSync("unzip", ["-p", zip, "plugin.json"]));
    const supplied = r.tool("check.mjs", "--base", base, "--released", `alpha@1.0.0=${manifest}`);
    assert.equal(supplied.status, 0, supplied.stderr);
    assert.equal(supplied.stderr, "");
  });
});

describe("plugin alert drift checks", () => {
  for (const [name, removedKind] of [["meeting", "summary-ready"]]) {
    it(`${name} rejects a runtime alert kind missing from its manifest`, () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), `alerts-${name}-`)));
      scratch.push(root);
      const source = join(REAL_ROOT, "plugins", name, "source");
      cpSync(join(source, "scripts"), join(root, "scripts"), { recursive: true });
      cpSync(join(source, "src"), join(root, "src"), { recursive: true });
      mkdirSync(join(root, "node_modules", "@ave"), { recursive: true });
      symlinkSync(join(REAL_ROOT, "contract"), join(root, "node_modules", "@ave", "plugin-contract"));
      const manifest = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"));
      manifest.extensions["ai.agent-connector.ave"].alerts.kinds = manifest.extensions["ai.agent-connector.ave"].alerts.kinds.filter((kind) => kind.id !== removedKind);
      writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest));
      const result = spawnSync("node", [join(root, "scripts", "validate-alerts.mjs")], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(`runtime raises "${removedKind}" without an alerts\\.kinds declaration`, "u"));
    });
  }
});
