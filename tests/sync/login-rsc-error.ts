export function isLoginRscAccessControlError(error: string, origin: string): boolean {
  const requestUrl = error.match(
    /^Fetch API cannot load (\S+) due to access control checks\.$/m,
  )?.[1];
  const frame = error.split("\n").find((line) => /^\s+at /.test(line));
  const scriptUrl = frame?.match(/^\s+at (?:[^()]+ \()?(\S+):\d+:\d+\)?$/)?.[1];
  if (!requestUrl || !scriptUrl) return false;
  try {
    const expectedOrigin = new URL(origin).origin;
    const request = new URL(requestUrl);
    const script = new URL(scriptUrl);
    return (
      request.origin === expectedOrigin &&
      request.pathname === "/login" &&
      !!request.searchParams.get("_rsc") &&
      request.hash === "" &&
      script.origin === expectedOrigin &&
      script.pathname.startsWith("/_next/static/chunks/") &&
      script.pathname.endsWith(".js")
    );
  } catch {
    return false;
  }
}
