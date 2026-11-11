import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pluginAuthority, compareVersions } from "../repo.mjs";

// Exercise the real official manifests and descriptors, not synthetic packages.
// Release bytes are independently checked by release.mjs verify.
for (const name of ["hello-world", "local-indexer", "meeting"]) {
  test(`${name}: the protocol-5 source is ready for a later release pin`, () => {
    const read = (path) => JSON.parse(readFileSync(new URL(`../../plugins/${name}/${path}`, import.meta.url), "utf8"));
    const descriptor = read("ave-package.json");
    const source = read("source/plugin.json");
    const pkg = read("source/package.json");
    const { authority, minAppVersion, hostProtocol, problems } = pluginAuthority(source);
    assert.equal(problems, undefined);
    assert.equal(pkg.version, source.version);
    assert.equal(hostProtocol, "5");
    assert.equal(minAppVersion, "0.15.0");
    if (descriptor.payload.artifact.release.tag === `${name}-v${source.version}`) {
      assert.equal(descriptor.version, source.version);
      assert.equal(descriptor.hostProtocol, hostProtocol);
      assert.equal(descriptor.minAppVersion, minAppVersion);
      assert.deepEqual(descriptor.payload.authority, authority);
    } else {
      assert.ok(compareVersions(source.version, descriptor.version) > 0,
        "unreleased source must be newer than the released descriptor");
    }
  });
}

test("the extension template starts with the first protocol-5 app release", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../../templates/extension/${name}`, import.meta.url), "utf8"));
  const manifest = read("plugin.json");
  assert.equal(manifest.version, read("package.json").version);
  assert.deepEqual(manifest.extensions["ai.agent-connector.ave"].requires, {
    minAppVersion: "0.15.0", hostProtocol: "5",
  });
});
