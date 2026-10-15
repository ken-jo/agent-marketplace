/**
 * One-time conversion of the server marketplace's seed set into packages
 * (blueprint 0.6). Kept as the record of how agents/, skills/, mcp/,
 * providers/, themes/ and languages/ were made; the packages are maintained
 * in place from now on, and this script is not run again.
 *
 * It reads two checkouts:
 * - agent-marketplace: `packages/{agents,skills,mcp}` and the provider seeds
 *   in `server/src/ave_marketplace/asset_catalog.py`;
 * - ave: the compiled theme bundles and their `styles.css` surfaces,
 *   the English and Korean catalogs, the vendor defaults.
 *
 * Run from the ave checkout so `tsx` resolves the app's modules:
 *
 *   cd <ave> && node --import tsx <this repo>/tools/import/convert-seeds.ts \
 *     --server <agent-marketplace> --out <this repo>
 *
 * The server had no messaging-connection seeds, so there is nothing of that
 * kind to convert. Validation is the repository check (`bun run validate`),
 * which runs the app's own rules over the result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const MIN_APP_VERSION = "0.10.0";
const NAME = /^(?!.*--)[a-z][a-z0-9-]*[a-z0-9]$/u;
const LICENSE = /^[A-Za-z0-9.+ ()-]+$/u;

function option(name: string): string {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return resolve(value);
}

const APP = process.cwd();
const SERVER = option("--server");
const OUT = option("--out");
const SEEDS = join(SERVER, "packages");
const problems: string[] = [];

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function write(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function packageName(kind: string, name: string): string {
  if (name.length < 3 || name.length > 64 || !NAME.test(name)) problems.push(`${kind}/${name}: not a package name`);
  return name;
}

/**
 * Source, license and author from the Ave-written NOTICE.md, which comes in
 * two forms: "Source: <url>" / "License: <id>, Copyright …" lines, or the
 * upstream URL on a line of its own and "licensed under the <id> License".
 */
function attribution(dir: string, manifestAuthor: unknown): Record<string, unknown> {
  const notice = existsSync(join(dir, "NOTICE.md")) ? readFileSync(join(dir, "NOTICE.md"), "utf8") : "";
  const source = /^Source:\s*(https:\/\/\S+)/mu.exec(notice)?.[1] ?? /^(https:\/\/\S+)$/mu.exec(notice)?.[1];
  // The identifier leads; a qualifier after it stays in the upstream text.
  const license = /^License:\s*([A-Za-z0-9.+-]+)/mu.exec(notice)?.[1] ?? /licensed under the ([A-Za-z0-9.+-]+) License/u.exec(notice)?.[1];
  // A package Ave wrote itself names no upstream; one copied from upstream must name its license.
  if (source && !license) problems.push(`${dir}: NOTICE.md names ${source} but no license`);
  const author = typeof manifestAuthor === "string" ? manifestAuthor.replace(/\s*\([^)]*\)\s*$/u, "").trim() : undefined;
  const out: Record<string, unknown> = {};
  if (author) out.author = source ? { name: author.slice(0, 100), url: source } : { name: author.slice(0, 100) };
  if (license && LICENSE.test(license)) out.license = license;
  else if (license) problems.push(`${dir}: license "${license}" is not an identifier`);
  if (source) out.homepage = source;
  return out;
}

function descriptor(kind: string, name: string, version: string, fields: Record<string, unknown>, payload: unknown) {
  const description = typeof fields.description === "string" ? fields.description.slice(0, 1000) : undefined;
  return {
    schemaVersion: 1,
    kind,
    name,
    version,
    minAppVersion: MIN_APP_VERSION,
    ...(typeof fields.displayName === "string" ? { displayName: fields.displayName.slice(0, 100) } : {}),
    ...(description ? { description } : {}),
    ...(fields.author ? { author: fields.author } : {}),
    ...(fields.license ? { license: fields.license } : {}),
    ...(fields.homepage ? { homepage: fields.homepage } : {}),
    payload,
  };
}

function agents(): number {
  const root = join(SEEDS, "agents");
  let count = 0;
  for (const id of readdirSync(root).sort()) {
    const dir = join(root, id);
    const manifest = readJson(join(dir, "plugin.json"));
    const name = packageName("agent", id);
    write(join(OUT, "agents", name, "AGENTS.md"), readFileSync(join(dir, "AGENTS.md")));
    const fields = { displayName: manifest.name, description: manifest.description, ...attribution(dir, manifest.author) };
    write(join(OUT, "agents", name, "ave-package.json"), json(descriptor("agent", name, String(manifest.version), fields, { entry: "AGENTS.md" })));
    count += 1;
  }
  return count;
}

/** Files a seed skill kept for its own development, not for the model. */
const DEV_ONLY = [/(^|\/)__pycache__\//u, /^tests\//u, /(^|\/)test_[^/]*\.py$/u, /^README\.md$/u, /(^|\/)\.gitignore$/u, /^plugin\.json$/u];

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path, base) : [relative(base, path)];
  });
}

/**
 * Where a seed skill file goes in the Agent Skills layout: scripts/,
 * references/ and assets/ stay; any other directory moves under assets/;
 * an upstream license or notice sits beside SKILL.md; another top-level
 * document goes to references/.
 */
function skillTarget(path: string, files: readonly string[]): string {
  if (path === "SKILL.md" || /^(scripts|references|assets)\//u.test(path)) return path;
  if (path === "NOTICE") return "NOTICE";
  // The Ave attribution (source, license, the upstream commit it was copied from) travels with the skill.
  if (path === "NOTICE.md") return files.includes("NOTICE") ? "references/NOTICE.md" : "NOTICE";
  if (path === "LICENSE") return "LICENSE";
  // An upstream's license beside a wrapper under another license: kept as a document, not as the skill's LICENSE.
  if (path === "LICENSE.upstream") return "references/LICENSE.upstream.txt";
  if (path.includes("/")) return `assets/${path}`;
  return `references/${path}`;
}

const TEXT = /\.(md|txt|json|ya?ml|py|js|mjs|cjs|sh)$/u;

function skills(): number {
  const root = join(SEEDS, "skills");
  let count = 0;
  for (const id of readdirSync(root).sort()) {
    const dir = join(root, id);
    const manifest = readJson(join(dir, "plugin.json"));
    const name = packageName("skill", id);
    const files = listFiles(dir).filter((path) => !DEV_ONLY.some((re) => re.test(path)));
    const moves = new Map(files.map((path) => [path, skillTarget(path, files)]));
    // References to a moved path, bare or behind the skill's own directory name, follow the move.
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const rewrites: Array<[RegExp, string]> = [];
    for (const top of new Set(files.filter((path) => path.includes("/") && moves.get(path) !== path).map((path) => path.split("/")[0]!))) {
      rewrites.push([new RegExp(`(?<![A-Za-z0-9_./-])((?:\\./)?(?:${escape(id)}/)?)${escape(top)}/`, "gu"), `$1assets/${top}/`]);
      // Scripts that build the path from parts: Python `ROOT / "top"`, Node `path.join(__dirname, "..", "top")`.
      rewrites.push([new RegExp(`(/\\s*)(["'])${escape(top)}\\2`, "gu"), `$1$2assets$2 / $2${top}$2`]);
      rewrites.push([new RegExp(`(["'])\\.\\.\\1,\\s*(["'])${escape(top)}\\2`, "gu"), `$1..$1, $2assets$2, $2${top}$2`]);
    }
    for (const [from, to] of moves) {
      if (from.includes("/") || from === to) continue;
      rewrites.push([new RegExp(`(?<![A-Za-z0-9_./-])((?:\\./)?(?:${escape(id)}/)?)${escape(from)}(?![A-Za-z0-9_.-])`, "gu"), `$1${to}`]);
      // A shell installer copies the file from the skill root it calls WRAPPER_DIR; where the copy lands is its own business.
      rewrites.push([new RegExp(`(\\$\\{WRAPPER_DIR\\}/)${escape(from)}(?![A-Za-z0-9_.-])`, "gu"), `$1${to}`]);
    }
    for (const [from, to] of moves) {
      let data: Buffer | string = readFileSync(join(dir, from));
      if (TEXT.test(to)) data = rewrites.reduce((text, [pattern, next]) => text.replace(pattern, next), data.toString("utf8"));
      write(join(OUT, "skills", name, to), data);
    }
    const fields = { displayName: manifest.name, description: manifest.description, ...attribution(dir, manifest.author) };
    write(join(OUT, "skills", name, "ave-package.json"), json(descriptor("skill", name, String(manifest.version), fields, { entry: "SKILL.md" })));
    count += 1;
  }
  return count;
}

function mcp(): number {
  const root = join(SEEDS, "mcp");
  let count = 0;
  for (const id of readdirSync(root).sort()) {
    const dir = join(root, id);
    const manifest = readJson(join(dir, "plugin.json"));
    const name = packageName("mcp", id);
    const runtime = manifest.runtime as Record<string, unknown>;
    const server: Record<string, unknown> = { transport: runtime.transport, command: runtime.command };
    for (const key of ["args", "env", "auth", "apiKeyEnv"]) if (runtime[key] !== undefined) server[key] = runtime[key];
    // The seeds ship no server files, so $PLUGIN_DIR was the extracted zip used as a place for data;
    // the package's own data directory is $DATA_DIR, which survives updates (design §5.2).
    const toDataDir = (value: unknown) => (typeof value === "string" ? value.replaceAll("$PLUGIN_DIR", "$DATA_DIR") : value);
    if (Array.isArray(server.args)) server.args = server.args.map(toDataDir);
    if (server.env && typeof server.env === "object") server.env = Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, toDataDir(value)]));
    const unknown = Object.keys(runtime).filter((key) => !["transport", "command", "args", "env", "auth", "apiKeyEnv"].includes(key));
    if (unknown.length > 0) problems.push(`mcp/${name}: runtime fields not carried: ${unknown.join(", ")}`);
    const fields = { displayName: manifest.name, description: manifest.description, ...attribution(dir, manifest.author) };
    write(join(OUT, "mcp", name, "ave-package.json"), json(descriptor("mcp", name, String(manifest.version), fields, { server })));
    count += 1;
  }
  return count;
}

async function providers(): Promise<number> {
  const seeds = JSON.parse(
    execFileSync(
      "python3",
      ["-c", "import json, ave_marketplace.asset_catalog as a; print(json.dumps([dict(p.package_asset, displayName=p.display_name, description=p.description) for p in a._PROVIDER_PACKAGES]))"],
      { cwd: join(SERVER, "server", "src"), encoding: "utf8" },
    ),
  ) as Array<Record<string, string>>;
  const vendors = (await import(join(APP, "src/shared/llm-vendor-defaults.ts"))) as { isMarketplaceEligibleLLMVendor(id: unknown): boolean };
  let count = 0;
  for (const seed of seeds) {
    // The app renamed the two vendor ids that could not be package names.
    const providerId = ({ nousResearch: "nous-research", v0: "vercel-v0" } as Record<string, string>)[seed.providerId] ?? seed.providerId;
    if (!vendors.isMarketplaceEligibleLLMVendor(providerId)) {
      problems.push(`provider/${providerId}: not a marketplace-eligible vendor of this app`);
      continue;
    }
    const name = packageName("provider", providerId);
    // A built-in vendor carries its own label, address and default model; the package only unlocks it.
    write(join(OUT, "providers", name, "provider.json"), json({ providerId }));
    const fields = { displayName: seed.displayName, description: seed.description };
    write(join(OUT, "providers", name, "ave-package.json"), json(descriptor("provider", name, "1.0.0", fields, { entry: "provider.json" })));
    count += 1;
  }
  return count;
}

/** The surface ladder of each compiled bundle, from its `styles.css` block. */
function surfacesOf(css: string, id: string, names: readonly string[]): Record<string, string> {
  const start = css.indexOf(`:root[data-theme-bundle="${id}"] {`);
  if (start < 0) throw new Error(`styles.css has no block for ${id}`);
  const block = css.slice(start, css.indexOf("}", start));
  const surfaces: Record<string, string> = {};
  for (const name of names) {
    const value = new RegExp(`--${name}:\\s*([^;]+);`, "u").exec(block)?.[1]?.trim();
    if (!value) throw new Error(`${id}: styles.css block has no --${name}`);
    surfaces[name] = value;
  }
  return surfaces;
}

async function themes(): Promise<number> {
  const bundles = (await import(join(APP, "src/shared/theme-bundles.ts"))) as { MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS: readonly string[] };
  const tokens = (await import(join(APP, "src/shared/theme-tokens.ts"))) as { THEME_SURFACE_NAMES: readonly string[] };
  const css = readFileSync(join(APP, "src/styles.css"), "utf8");
  const dir = join(APP, "src/ui/renderer/theme/bundles");
  let count = 0;
  for (const id of bundles.MARKETPLACE_ELIGIBLE_THEME_BUNDLE_IDS) {
    const module = (await import(join(dir, `${id}.ts`))) as Record<string, { id: string; name: string; description: string; shell: string; highContrast: boolean; tokens: Record<string, string> }>;
    const bundle = Object.values(module).find((value) => value && typeof value === "object" && value.id === id);
    if (!bundle) throw new Error(`${id}.ts exports no bundle with id ${id}`);
    const name = packageName("theme", id);
    const theme = {
      name: bundle.name,
      description: bundle.description,
      shell: bundle.shell,
      highContrast: bundle.highContrast,
      tokens: bundle.tokens,
      surfaces: surfacesOf(css, id, tokens.THEME_SURFACE_NAMES),
    };
    write(join(OUT, "themes", name, "theme.json"), json(theme));
    const fields = { displayName: bundle.name, description: bundle.description };
    write(join(OUT, "themes", name, "ave-package.json"), json(descriptor("theme", name, "1.0.0", fields, { entry: "theme.json" })));
    count += 1;
  }
  return count;
}

async function korean(): Promise<number> {
  const catalogs = (await import(join(APP, "src/i18n/messages/index.ts"))) as {
    messages: Record<string, Record<string, string>>;
    loadLocaleMessages(locale: string): Promise<Record<string, string>>;
  };
  const messages = { en: catalogs.messages.en!, ko: await catalogs.loadLocaleMessages("ko") };
  const { isModelFacingKey } = (await import(join(APP, "src/i18n/model-facing.ts"))) as { isModelFacingKey(key: string): boolean };
  const placeholders = (value: string) => [...new Set([...value.matchAll(/\{([a-zA-Z0-9_]+)\}/gu)].map((m) => m[1]))].sort().join(",");
  const catalog: Record<string, string> = {};
  let mismatched = 0;
  for (const key of Object.keys(messages.ko).sort()) {
    const english = messages.en[key];
    const value = messages.ko[key];
    if (english === undefined || isModelFacingKey(key)) continue;
    // An empty English message is deliberate (a slot some surfaces leave blank); the package leaves it to English.
    if (value === "" && english === "") continue;
    if (value === "") {
      problems.push(`language/korean: ${key} is empty but English is not`);
      continue;
    }
    if (placeholders(value) !== placeholders(english)) {
      mismatched += 1;
      problems.push(`language/korean: ${key} does not keep the English placeholders`);
      continue;
    }
    catalog[key] = value;
  }
  const dir = join(OUT, "languages", "korean");
  write(join(dir, "language.json"), json({ locale: "ko", nativeName: "한국어", englishName: "Korean" }));
  write(join(dir, "messages.json"), json(catalog));
  const fields = { displayName: "한국어 (Korean)", description: "Korean interface translation, updated without an app release." };
  write(join(dir, "ave-package.json"), json(descriptor("language", "korean", "1.0.0", fields, { locale: "ko", entry: "language.json", messages: "messages.json" })));
  return mismatched === 0 ? 1 : 0;
}

for (const kind of ["agents", "skills", "mcp", "providers", "themes", "languages"]) rmSync(join(OUT, kind), { recursive: true, force: true });
const counts = {
  agents: agents(),
  skills: skills(),
  mcp: mcp(),
  providers: await providers(),
  themes: await themes(),
  languages: await korean(),
};
console.log(JSON.stringify(counts));
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
