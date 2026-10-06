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

const workerEntryPattern =
  /"static\/chunks\/turbopack-worker-[A-Za-z0-9_.-]+\.js",\[((?:"static\/chunks\/[A-Za-z0-9_.-]+\.(?:js|css)",?)+)\]/g;

/**
 * The chunks only the Kestrel worker reaches. They are useless offline until
 * the model weights exist, which only a first online narration downloads, so
 * a service worker may wait for the verified model bundle before caching them.
 * Everything another part of the runtime closure also reaches stays eager.
 */
export function collectModelOnlyChunkNames(sources, selected, workerMarker) {
  const kestrelEntries = new Set();
  for (const source of sources.values()) {
    for (const match of source.matchAll(workerEntryPattern)) {
      const entries = [...match[1].matchAll(/static\/chunks\/([A-Za-z0-9_.-]+\.(?:js|css))/g)].map(
        (entry) => entry[1],
      );
      if (entries.some((entry) => (sources.get(entry) || "").includes(workerMarker))) {
        for (const entry of entries) kestrelEntries.add(entry);
      }
    }
  }
  if (kestrelEntries.size === 0) throw new Error("The Kestrel worker entry chunks were not found.");

  const reach = (roots, blocked) => {
    const seen = new Set();
    const queue = [...roots];
    while (queue.length > 0) {
      const filename = queue.shift();
      if (seen.has(filename) || blocked.has(filename)) continue;
      seen.add(filename);
      for (const match of (sources.get(filename) || "").matchAll(dependencyPattern)) {
        queue.push(match[1]);
      }
    }
    return seen;
  };
  const kestrelOnly = reach(kestrelEntries, new Set());
  const elsewhere = reach(
    selected.filter((filename) => !kestrelOnly.has(filename)),
    kestrelEntries,
  );
  return [...kestrelOnly].filter((filename) => !elsewhere.has(filename)).sort();
}
