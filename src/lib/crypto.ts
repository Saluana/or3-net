/**
 * @module src/lib/crypto
 *
 * Purpose:
 * Shared cryptographic primitives for OR3 Net auth and integrity checks.
 *
 * Non-responsibilities:
 * - Does not manage key storage
 * - Does not implement asymmetric signing or encryption
 */
const encoder = new TextEncoder();

const toArrayBuffer = (value: string): ArrayBuffer => {
  const encoded = encoder.encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

/**
 * Purpose:
 * Computes the SHA-256 digest of a UTF-8 string and returns it as lowercase hex.
 */
export const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(input));
  return toHex(new Uint8Array(digest));
};

/**
 * Purpose:
 * Computes an HMAC-SHA256 signature for a message using a shared secret.
 */
export const hmacSha256Hex = async (secret: string, message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, toArrayBuffer(message));
  return toHex(new Uint8Array(signature));
};

/**
 * Purpose:
 * Encodes UTF-8 text as unpadded base64url for token-safe transport.
 */
export const encodeBase64Url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
/**
 * Purpose:
 * Decodes base64url text produced by OR3 token helpers.
 */
export const decodeBase64Url = (value: string): string => Buffer.from(value, "base64url").toString("utf8");
/**
 * Purpose:
 * Normalizes and hashes a plaintext API key before storage or lookup.
 */
export const hashApiKey = async (token: string): Promise<string> => sha256Hex(token.trim());