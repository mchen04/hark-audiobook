export type TombstoneWindow =
  | { emit: false }
  | {
      emit: true;
      floor: string;
      ceiling: string | null;
      advancesCursor: boolean;
    };

export function planTombstoneWindow(
  since: string | null,
  page: { complete: boolean; watermark: string },
): TombstoneWindow {
  if (since === null) return { emit: false };
  return page.complete
    ? { emit: true, floor: since, ceiling: null, advancesCursor: true }
    : { emit: true, floor: since, ceiling: page.watermark, advancesCursor: false };
}
