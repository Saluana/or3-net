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

export const canonicalizeManifestPayload = (manifestInput: NodeManifest): Uint8Array => {
  const { signature, ...unsignedManifest } = manifestInput;
  void signature;
  return encoder.encode(JSON.stringify(sortJson(unsignedManifest)));
};

export const verifyNodeManifestSignature = (manifestInput: NodeManifest): boolean => {
  const payload = canonicalizeManifestPayload(manifestInput);
  const publicKey = Buffer.from(manifestInput.pubkey, "base64");
  const signature = Buffer.from(manifestInput.signature, "base64");
  return nacl.sign.detached.verify(payload, new Uint8Array(signature), new Uint8Array(publicKey));
};

export const signNodeManifest = (manifestInput: Omit<NodeManifest, "signature">, secretKey: Uint8Array): string => {
  const payload = canonicalizeManifestPayload({ ...manifestInput, signature: Buffer.alloc(64).toString("base64") });
  return Buffer.from(nacl.sign.detached(payload, secretKey)).toString("base64");
};