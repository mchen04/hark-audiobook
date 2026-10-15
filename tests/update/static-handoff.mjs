export function classifyStaticFailures(evidence, previous, next) {
  const accepted = [];
  const rejected = [];
  for (const failure of evidence.failedStatic) {
    const document = evidence.documents.find((entry) => entry.id === failure.documentId);
    const url = new URL(failure.url);
    const expectedSha256 = next.assets[url.pathname];
    let proof;
    if (
      failure.failure?.errorText === "cancelled" &&
      failure.step === "switch-and-open-lazy-routes" &&
      failure.failedStep === failure.step &&
      document?.buildId === previous.buildId &&
      document.htmlSha256 &&
      url.origin === new URL(document.url).origin &&
      expectedSha256
    ) {
      for (const navigation of evidence.navigations) {
        if (
          navigation.mainFrame !== true ||
          navigation.step !== failure.step ||
          navigation.fromDocumentId !== document.id ||
          navigation.requestedAt <= failure.requestedAt
        )
          continue;
        const destination = evidence.documents.find((entry) => entry.id === navigation.id);
        const reload = evidence.staticResponses.find(
          (entry) =>
            entry.url === failure.url &&
            entry.requestId !== failure.requestId &&
            entry.documentId === navigation.id &&
            entry.step === failure.step &&
            entry.requestedAt > navigation.requestedAt &&
            entry.finishedAt > failure.failedAt &&
            entry.finishedAt > entry.requestedAt &&
            entry.status === 200 &&
            entry.sha256 === expectedSha256,
        );
        if (destination?.buildId === next.buildId && destination.htmlSha256 && reload) {
          proof = { failure, document, navigation, destination, reload, expectedSha256 };
          break;
        }
      }
    }
    if (proof) accepted.push(proof);
    else rejected.push(failure);
  }
  return { accepted, rejected };
}
