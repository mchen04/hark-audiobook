export function singleFlight<T>(
  active: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = active.get(key);
  if (existing) return existing;
  const flight = run().finally(() => {
    if (active.get(key) === flight) active.delete(key);
  });
  active.set(key, flight);
  return flight;
}
