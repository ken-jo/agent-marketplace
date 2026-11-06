#!/usr/bin/env node
/** Validate the extension manifest against the shared Ave schema. */
import { readFileSync } from "node:fs";
import Ajv from "ajv";

const schema = JSON.parse(readFileSync(new URL(import.meta.resolve("@ave/plugin-contract/plugin-manifest.schema.json")), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);
if (!validate(manifest)) {
  console.error(ajv.errorsText(validate.errors, { separator: "\n" }));
  process.exitCode = 1;
} else {
  console.log("extension manifest: OK");
}
