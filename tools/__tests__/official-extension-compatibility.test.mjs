import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pluginAuthority, compareVersions } from "../repo.mjs";

// Exercise the real official manifests and descriptors, not synthetic packages.
// Release bytes are independently checked by release.mjs verify.
for (const [name, previous] of [["hello-world", "0.3.2"], ["local-indexer", "0.7.2"], ["meeting", "0.10.2"]]) {
  test(`${name}: the protocol-5 descriptor agrees with its source authority`, () => {
    const read = (path) => JSON.parse(readFileSync(new URL(`../../plugins/${name}/${path}`, import.meta.url), "utf8"));
    const descriptor = read("ave-package.json");
    const source = read("source/plugin.json");
    const pkg = read("source/package.json");
    const { authority, minAppVersion, hostProtocol, problems } = pluginAuthority(source);
    assert.equal(problems, undefined);
    assert.equal(descriptor.version, source.version);
    assert.equal(pkg.version, source.version);
    assert.ok(compareVersions(source.version, previous) > 0);
    assert.equal(hostProtocol, "5");
    assert.equal(minAppVersion, "0.14.2");
    assert.equal(descriptor.hostProtocol, hostProtocol);
    assert.equal(descriptor.minAppVersion, minAppVersion);
    assert.deepEqual(descriptor.payload.authority, authority);
  });
}
