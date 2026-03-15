/**
 * @module src/nodes/signatures
 *
 * Purpose:
 * Canonical manifest signing and verification helpers for enrolled nodes.
 *
 * Constraints:
 * - Manifests are canonicalized with stable object-key ordering
 * - Signature fields are excluded from the signed payload
 */
import nacl from "tweetnacl";

import type { NodeManifest } from "../contracts/index.ts";

const encoder = new TextEncoder();

const sortJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortJson(nested)]),
    );
  }
  return value;
};

/** Purpose: Canonicalizes a node manifest into bytes for signing and verification. */
export const canonicalizeManifestPayload = (manifestInput: NodeManifest): Uint8Array => {
  const { signature, ...unsignedManifest } = manifestInput;
  void signature;
  return encoder.encode(JSON.stringify(sortJson(unsignedManifest)));
};

/** Purpose: Verifies a detached Ed25519 signature for a node manifest. */
export const verifyNodeManifestSignature = (manifestInput: NodeManifest): boolean => {
  const payload = canonicalizeManifestPayload(manifestInput);
  const publicKey = Buffer.from(manifestInput.pubkey, "base64");
  const signature = Buffer.from(manifestInput.signature, "base64");
  return nacl.sign.detached.verify(payload, new Uint8Array(signature), new Uint8Array(publicKey));
};

/** Purpose: Signs a node manifest using the supplied Ed25519 secret key. */
export const signNodeManifest = (manifestInput: Omit<NodeManifest, "signature">, secretKey: Uint8Array): string => {
  const payload = canonicalizeManifestPayload({ ...manifestInput, signature: Buffer.alloc(64).toString("base64") });
  return Buffer.from(nacl.sign.detached(payload, secretKey)).toString("base64");
};