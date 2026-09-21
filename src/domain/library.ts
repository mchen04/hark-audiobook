export type LibraryBook = {
  id: string;
  title: string;
  author: string;
  narrator: string | null;
  series: string | null;
  chapterDiagnostic: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  durationMs: number | null;
  positionMs: number | null;
  completed: boolean | null;
  progressUpdatedAt: string | null;
};

export type LibrarySort = "activity" | "added" | "title" | "author";
export type LibraryStatus = "all" | "in-progress" | "not-started" | "finished" | "archived";
export type LibraryQuery = {
  query?: string;
  status?: LibraryStatus;
  tag?: string | null;
  sort?: LibrarySort;
};

/** The same rules apply to mirrored books and imports not yet seen by sync. */
export function filterLibraryBooks(books: LibraryBook[], input: LibraryQuery): LibraryBook[] {
  const needle = input.query?.trim().toLowerCase();
  return books
    .filter((book) => {
      if (!matchesLibraryStatus(book, input.status ?? "all")) return false;
      if (input.tag && !book.tags.includes(input.tag)) return false;
      return (
        !needle ||
        `${book.title} ${book.author} ${book.narrator ?? ""} ${book.series ?? ""}`
          .toLowerCase()
          .includes(needle) ||
        book.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    })
    .sort(libraryComparator(input.sort ?? "activity"));
}

function matchesLibraryStatus(book: LibraryBook, status: LibraryStatus): boolean {
  const archived = book.archivedAt !== null;
  if (status === "archived") return archived;
  if (archived) return false;
  const completed = book.completed || false;
  const positionMs = book.positionMs || 0;
  if (status === "finished") return completed;
  if (status === "in-progress") return !completed && positionMs > 0;
  if (status === "not-started") return !completed && positionMs === 0;
  return true;
}

export function selectContinueBook(books: LibraryBook[]): LibraryBook | null {
  let best: { book: LibraryBook; listenedAt: string } | null = null;
  for (const book of books) {
    const listenedAt = book.progressUpdatedAt;
    if (!listenedAt || !matchesLibraryStatus(book, "in-progress")) continue;
    if (
      !best ||
      listenedAt > best.listenedAt ||
      (listenedAt === best.listenedAt && book.id > best.book.id)
    )
      best = { book, listenedAt };
  }
  return best?.book ?? null;
}

function libraryComparator(sort: LibrarySort): (left: LibraryBook, right: LibraryBook) => number {
  if (sort === "title" || sort === "author") {
    return (left, right) =>
      left[sort].toLowerCase().localeCompare(right[sort].toLowerCase()) ||
      left.id.localeCompare(right.id);
  }
  if (sort === "added")
    return (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
  return (left, right) =>
    activityAt(right).localeCompare(activityAt(left)) || right.id.localeCompare(left.id);
}

function activityAt(book: LibraryBook): string {
  return book.progressUpdatedAt && book.progressUpdatedAt > book.updatedAt
    ? book.progressUpdatedAt
    : book.updatedAt;
}
