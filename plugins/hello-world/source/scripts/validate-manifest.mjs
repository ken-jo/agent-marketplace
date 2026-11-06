// Validate the signed manifest against the vendored host schema.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const schema = JSON.parse(readFileSync(new URL('../../../../contract/plugin-manifest.schema.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../plugin.json', import.meta.url), 'utf8'));
if (!ajv.validate(schema, manifest)) throw new Error(JSON.stringify(ajv.errors, null, 2));
console.log('manifest contract: OK');
