const dependencyPattern = /(?:\/?_next\/)?static\/chunks\/([A-Za-z0-9_.-]+\.(?:js|css))/g;

/**
 * Close over both sides of the offline import path.
 *
 * Kestrel's implementation chunks are found by their private bundle marker.
 * The route manifests supply the client ancestors that can invoke that bundle
 * after an offline navigation, including React-loadable children. Turbopack
 * writes worker runtimes and dynamic imports as literal chunk paths inside
 * those files, so walking the union captures their descendants too.
 */
export function collectRuntimeChunkNames(sources, offlineRouteManifests) {
  const available = new Set(sources.keys());
  const queue = [...sources]
    .filter(([, source]) => source.includes("hark-kestrel"))
    .map(([filename]) => filename);
  if (queue.length === 0) throw new Error("The built Kestrel runtime entry could not be found.");

  for (const manifest of offlineRouteManifests) {
    for (const match of manifest.matchAll(dependencyPattern)) queue.push(match[1]);
  }

  const selected = new Set();
  while (queue.length > 0) {
    const filename = queue.shift();
    if (selected.has(filename)) continue;
    if (!available.has(filename)) {
      throw new Error(`The document runtime references a missing build chunk: ${filename}`);
    }

    selected.add(filename);
    const source = sources.get(filename) || "";
    for (const match of source.matchAll(dependencyPattern)) {
      if (!selected.has(match[1])) queue.push(match[1]);
    }
  }

  return [...selected].sort();
}
