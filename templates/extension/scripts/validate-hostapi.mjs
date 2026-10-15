#!/usr/bin/env node
// validate-hostapi.mjs — HostApi contract drift guard.
//
// Cross-checks that every hostApi.* call the extension makes at the TypeScript
// level is consistent with what plugin.json declares, using the canonical
// manifest vocabulary (matches the host contract's PluginManifest schema and
// the meeting manifest). Specifically:
//
//   1. hostApi.registerKeywords([...]) skillIds  ↔  plugin.json "keywords"
//   2. hostApi.addTask(...)     requires the "host:tasks"   capability
//   3. hostApi.saveNote(...)    requires the "host:notes"   capability
//   4. hostApi.getSecret(...)   requires the "host:secrets" capability
//   5. hostApi.emitEvent(e,…)   e must be declared in "emittedEvents"
//   6. hostApi.onEvent(e,…)     e must be declared in "eventSubscriptions"
//
// Permissions are expressed through capability tags rather than a separate
// "permissions" array: the canonical schema has no "permissions" field, so the
// guard reads capabilities[] as the permission source.
//
// Exit code 0 → OK, 1 → drift detected.
//
// Usage: node scripts/validate-hostapi.mjs
//
// Pure fs + regex (no runtime deps). Safe to run in any CI env.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenAgentPluginsManifest } from "@ave/plugin-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// hostApi.<fn>(...) → capability tag that must be present in capabilities[].
const CAPABILITY_REQUIRING_CALLS = {
  addTask: "host:tasks",
  saveNote: "host:notes",
  getSecret: "host:secrets",
};

function walkTs(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      walkTs(p, out);
    } else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function loadManifest() {
  const p = join(ROOT, "plugin.json");
  if (!existsSync(p)) return null;
  try {
    return flattenAgentPluginsManifest(JSON.parse(readFileSync(p, "utf8")));
  } catch (err) {
    console.error(`plugin.json parse error: ${err.message}`);
    process.exit(1);
  }
}

// Read an optional array-valued manifest field strictly.
//
// A genuinely-absent optional field returns [] (the contract check that needs
// it will then fire loudly against any matching src/ usage). But a field that
// is PRESENT with a non-array type is a malformed manifest — we surface it as a
// hard error instead of silently coercing it to [] and disabling the check.
function readArrayField(manifest, name) {
  const value = manifest[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    console.error(
      `validate:hostapi — FAILED: plugin.json "${name}" must be an array, got ${typeof value}.`,
    );
    process.exit(1);
  }
  return value;
}

function main() {
  const srcDir = join(ROOT, "src");
  if (!existsSync(srcDir)) {
    console.log("validate:hostapi — no src/ directory, nothing to check.");
    return;
  }

  const calls = {
    emit: new Set(),
    subscribe: new Set(),
    addTask: false,
    saveNote: false,
    getSecret: false,
    registerKeywordsSkillIds: new Set(),
    registerKeywordsCalled: false,
  };
  for (const f of walkTs(srcDir)) {
    const src = readFileSync(f, "utf8");
    // Reconstruct stateful /g regexes per file so .test() lastIndex never bleeds.
    for (const m of src.matchAll(/hostApi\.emitEvent\(\s*["']([^"']+)["']/g)) {
      calls.emit.add(m[1]);
    }
    for (const m of src.matchAll(/hostApi\.onEvent\(\s*["']([^"']+)["']/g)) {
      calls.subscribe.add(m[1]);
    }
    if (/hostApi\.addTask\s*\(/.test(src)) calls.addTask = true;
    if (/hostApi\.saveNote\s*\(/.test(src)) calls.saveNote = true;
    if (/hostApi\.getSecret\s*\(/.test(src)) calls.getSecret = true;
    if (/hostApi\.registerKeywords\s*\(/.test(src)) {
      calls.registerKeywordsCalled = true;
      for (const m of src.matchAll(
        /\{\s*keyword\s*:\s*["'][^"']+["']\s*,\s*skillId\s*:\s*["']([^"']+)["']/g,
      )) {
        calls.registerKeywordsSkillIds.add(m[1]);
      }
    }
  }

  const manifest = loadManifest();
  const errors = [];
  const warnings = [];

  if (!manifest) {
    // No manifest → only complain if src actually calls hostApi.
    const usesHostApi =
      calls.emit.size > 0 ||
      calls.subscribe.size > 0 ||
      calls.addTask ||
      calls.saveNote ||
      calls.getSecret ||
      calls.registerKeywordsCalled;
    if (usesHostApi) {
      errors.push(
        `plugin.json missing but src/ uses hostApi — a manifest is required for HostApi contract validation.`,
      );
      report(errors, warnings, calls, null);
      process.exit(1);
    }
    console.log("validate:hostapi — OK (no manifest, no hostApi usage)");
    return;
  }

  const declaredKeywords = new Set(
    readArrayField(manifest, "keywords").map((k) => k.skillId).filter(Boolean),
  );
  const declaredTools = new Set(readArrayField(manifest, "tools"));
  const declaredCapabilities = new Set(readArrayField(manifest, "capabilities"));
  const declaredEmits = new Set(readArrayField(manifest, "emittedEvents"));
  // eventSubscriptions entries are either a plain string or { type, hint? }.
  const declaredSubscribes = new Set(
    readArrayField(manifest, "eventSubscriptions").map((e) =>
      typeof e === "string" ? e : e?.type,
    ),
  );

  // 1) registerKeywords ↔ manifest.keywords symmetry
  if (calls.registerKeywordsCalled && calls.registerKeywordsSkillIds.size > 0) {
    for (const sid of calls.registerKeywordsSkillIds) {
      if (!declaredKeywords.has(sid)) {
        errors.push(
          `registerKeywords uses skillId "${sid}" not found in plugin.json "keywords"`,
        );
      }
      if (declaredTools.size > 0 && !declaredTools.has(sid)) {
        warnings.push(
          `registerKeywords skillId "${sid}" is not listed in plugin.json "tools" (may be fine if it's a cross-plugin skill)`,
        );
      }
    }
    for (const kw of declaredKeywords) {
      if (!calls.registerKeywordsSkillIds.has(kw)) {
        warnings.push(
          `plugin.json "keywords" declares skillId "${kw}" but registerKeywords in src/ does not reference it (literal match)`,
        );
      }
    }
  } else if (declaredKeywords.size > 0) {
    warnings.push(
      `plugin.json declares ${declaredKeywords.size} keyword(s) but src/ makes no hostApi.registerKeywords call`,
    );
  }

  // 2–4) capability-requiring calls must declare the matching capability tag.
  for (const [fn, capability] of Object.entries(CAPABILITY_REQUIRING_CALLS)) {
    if (calls[fn] && !declaredCapabilities.has(capability)) {
      errors.push(
        `src/ calls hostApi.${fn}(...) but plugin.json "capabilities" does not include "${capability}"`,
      );
    }
  }
  // Also warn on unused declared capability tags (helps keep manifest honest).
  const reverseMap = {
    "host:tasks": "addTask",
    "host:notes": "saveNote",
    "host:secrets": "getSecret",
  };
  for (const cap of declaredCapabilities) {
    const fn = reverseMap[cap];
    if (fn && !calls[fn]) {
      warnings.push(
        `plugin.json "capabilities" declares "${cap}" but src/ has no hostApi.${fn}(...) call`,
      );
    }
  }

  // 5) emit ↔ emittedEvents
  for (const ev of calls.emit) {
    if (!declaredEmits.has(ev)) {
      errors.push(
        `hostApi.emitEvent("${ev}") found but plugin.json "emittedEvents" does not declare it`,
      );
    }
  }

  // 6) onEvent ↔ eventSubscriptions
  for (const ev of calls.subscribe) {
    if (!declaredSubscribes.has(ev)) {
      errors.push(
        `hostApi.onEvent("${ev}") found but plugin.json "eventSubscriptions" does not declare it`,
      );
    }
  }

  report(errors, warnings, calls, manifest);
  if (errors.length) process.exit(1);
}

function report(errors, warnings, calls, manifest) {
  if (warnings.length) {
    console.log("validate:hostapi — warnings:");
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  if (errors.length) {
    console.error("validate:hostapi — FAILED:");
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(
      `\nHostApi contract drift: ${errors.length} error(s). Align plugin.json or src/.`,
    );
    return;
  }
  const summary = {
    emit: [...calls.emit].sort(),
    subscribe: [...calls.subscribe].sort(),
    addTask: calls.addTask,
    saveNote: calls.saveNote,
    getSecret: calls.getSecret,
    registerKeywordsSkillIds: [...calls.registerKeywordsSkillIds].sort(),
    declaredCapabilities: manifest ? readArrayField(manifest, "capabilities") : [],
  };
  console.log("validate:hostapi — OK");
  console.log(JSON.stringify(summary, null, 2));
}

main();
