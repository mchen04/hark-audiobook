export async function resumeControl<T>(
  pending: Promise<T>,
  diagnostic: () => unknown,
  timeoutMs = 30_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Resume control stalled after ${timeoutMs}ms: ${JSON.stringify(diagnostic())}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function servedBuildId(html: string): string {
  const id = html.match(/\\+"b\\+":\\+"([^"\\]+)\\+"/)?.[1];
  if (!id) throw new Error("Served offline document has no build ID");
  return id;
}
