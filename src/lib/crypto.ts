const encoder = new TextEncoder();

const toArrayBuffer = (value: string): ArrayBuffer => {
  const encoded = encoder.encode(value);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(input));
  return toHex(new Uint8Array(digest));
};

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

export const encodeBase64Url = (value: string): string => Buffer.from(value, "utf8").toString("base64url");
export const decodeBase64Url = (value: string): string => Buffer.from(value, "base64url").toString("utf8");
export const hashApiKey = async (token: string): Promise<string> => sha256Hex(token.trim());