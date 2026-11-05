export async function liveBookDigest(bookIds: readonly string[]): Promise<string> {
  const text = [...bookIds].sort().join("\n");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let binary = "";
  for (const byte of new Uint8Array(hash)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
