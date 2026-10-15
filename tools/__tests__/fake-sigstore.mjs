/**
 * Test-only stand-ins for the contract bundle's network and Sigstore.
 *
 * vendor.mjs takes these only as function arguments, which the command line
 * never passes; no environment variable or flag switches it to them. A fake
 * "sigstore bundle" names an identity and issuer and carries an Ed25519
 * signature over SHA256SUMS made with a key generated per test.
 */
import { generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_BASE } from "../vendor.mjs";

export function testKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

export function testSignature(privateKey, artifact, identity, issuer) {
  return JSON.stringify({ testOnly: true, identity, issuer, signature: sign(null, artifact, privateKey).toString("base64") });
}

/** Verifier with the production contract: throws unless `bundle` signs `artifact` for exactly `identity` and `issuer`. */
export function testVerifier(publicKey) {
  const key = createPublicKey(publicKey);
  return ({ artifact, bundle, identity, issuer }) => {
    const parsed = JSON.parse(bundle.toString("utf8"));
    if (parsed.identity !== identity || parsed.issuer !== issuer) {
      throw new Error(`certificate names ${parsed.identity} (${parsed.issuer})`);
    }
    if (!verify(null, artifact, key, Buffer.from(parsed.signature, "base64"))) throw new Error("signature does not match the artifact");
  };
}

/** Serve `<dir>/<tag>/<name>` for `BUNDLE_BASE<tag>/<name>`, recording every URL asked for. */
export function servedFrom(dir, calls = []) {
  return async (url) => {
    calls.push(url);
    if (!url.startsWith(BUNDLE_BASE)) return { status: 404 };
    const path = join(dir, url.slice(BUNDLE_BASE.length));
    if (!existsSync(path)) return { status: 404 };
    return { status: 200, bytes: readFileSync(path) };
  };
}
