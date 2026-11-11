import { it } from 'node:test';
import assert from 'node:assert/strict';
import { runPluginChecks } from '../plugin-check.mjs';
it('accepts the official plugin directory and runs its source checks', async () => {
  const calls = [];
  await runPluginChecks('plugins/meeting', { execute: (command, args, options) => calls.push({ command, args, cwd: options.cwd }) });
  assert.ok(calls.slice(1).every(call => call.cwd.endsWith('/plugins/meeting/source')));
  assert.deepEqual(calls.filter(call => call.args[0] === 'run').map(call => call.args[1]), ['typecheck','build','test','validate:manifest']);
});
