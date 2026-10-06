export function collectRuntimeChunkNames(
  sources: ReadonlyMap<string, string>,
  offlineRouteManifests: readonly string[],
): string[];
export function collectModelOnlyChunkNames(
  sources: ReadonlyMap<string, string>,
  selected: readonly string[],
  workerMarker: string,
): string[];
