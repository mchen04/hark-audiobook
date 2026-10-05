/**
 * A fingerprint of an account's book ids, so a pull can skip resending the
 * complete id list when the device already holds exactly that set. Server and
 * device compute it the same way: ids sorted, newline-joined, SHA-256, base64url.
 */
export async function liveBookDigest(bookIds: readonly string[]): Promise<string> {
  const text = [...bookIds].sort().join("\n");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let binary = "";
  for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
