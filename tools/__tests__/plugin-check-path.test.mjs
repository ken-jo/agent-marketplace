import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runPluginChecks } from '../plugin-check.mjs';

test('plugin check accepts a marketplace plugin directory and its source directory', async () => {
  for (const directory of ['plugins/hello-world', 'plugins/hello-world/source']) {
    const calls = [];
    await runPluginChecks(directory, { execute: (command, args, options) => calls.push({ command, args, cwd: options.cwd }) });
    assert.equal(calls[1].cwd, resolve('plugins/hello-world/source'));
    assert.deepEqual(calls.filter(c => c.args[0] === 'run').map(c => c.args[1]), ['typecheck', 'build', 'test', 'validate:manifest']);
  }
});
