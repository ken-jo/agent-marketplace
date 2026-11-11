// Alert delivery remains a real server-side contract after view subscriptions retire.
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
const declared = new Set(manifest.extensions['ai.agent-connector.ave'].alerts?.kinds.map(kind => kind.id) ?? []);
const source = ['../src/hostPlugin.ts', '../src/alerts/meeting-summary-detector.ts'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n');
const raised = new Set([...source.matchAll(/\bkind:\s*["']([a-z][a-z0-9-]*)["']/g)].map(match => match[1]));
const errors = [];
for (const kind of raised) if (!declared.has(kind)) errors.push(`runtime raises "${kind}" without an alerts.kinds declaration`);
for (const kind of declared) if (!raised.has(kind)) errors.push(`alerts.kinds declares "${kind}" without a runtime raise path`);
if (errors.length) throw new Error(errors.join('\n'));
console.log('alert declarations: OK');
