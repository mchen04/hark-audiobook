export type BookPagePlan =
  | { kind: "final"; take: number; watermark: string }
  | { kind: "partial"; take: number; watermark: string }
  | { kind: "bucket"; boundary: string };

export function planBookPage(cursors: string[], floor: string, pageSize: number): BookPagePlan {
  if (cursors.length <= pageSize) {
    return { kind: "final", take: cursors.length, watermark: cursors.at(-1) || floor };
  }
  const boundary = cursors[pageSize]!;
  const take = cursors.slice(0, pageSize).filter((cursor) => cursor < boundary).length;
  if (!take) return { kind: "bucket", boundary };
  return { kind: "partial", take, watermark: cursors[take - 1]! };
}
