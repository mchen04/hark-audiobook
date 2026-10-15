interface Document {
  id: number;
  url: string;
  buildId: string | null;
  htmlSha256: string | null;
}
interface Navigation {
  mainFrame: boolean;
  id: number;
  requestedAt: number;
  fromDocumentId: number | null;
  step: string | null;
}
interface StaticRequest {
  url: string;
  requestId: number;
  requestedAt: number;
  documentId: number | null;
  step: string | null;
}
interface Failure extends StaticRequest {
  failure: { errorText: string } | null;
  failedAt: number;
  failedStep: string | null;
}
interface Response extends StaticRequest {
  status: number;
  sha256: string | null;
  finishedAt: number | null;
}
interface Evidence {
  failedStatic: Failure[];
  documents: Document[];
  navigations: Navigation[];
  staticResponses: Response[];
}
interface Build {
  buildId: string;
  assets: Record<string, string>;
}
export function classifyStaticFailures(
  evidence: Evidence,
  previous: Build,
  next: Build,
): {
  accepted: {
    failure: Failure;
    document: Document;
    navigation: Navigation;
    destination: Document;
    reload: Response;
    expectedSha256: string;
  }[];
  rejected: Failure[];
};
