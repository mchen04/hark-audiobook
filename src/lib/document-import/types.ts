import type { DocumentKind } from "@/lib/source-formats";

export type ExtractedDocumentChapter = {
  title: string;
  text: string;
};

export type ExtractedDocument = {
  kind: DocumentKind;
  title: string;
  author: string;
  chapters: ExtractedDocumentChapter[];
};
