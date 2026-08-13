/**
 * Names that live on user devices: localStorage keys and window events. The
 * historic "chapterline" prefix is permanent for anything already stored on
 * devices — renaming it would orphan existing state.
 */
export const ACTIVE_USER_KEY = "chapterline:active-user";
export const PENDING_ACCOUNT_DELETION_KEY = "chapterline:pending-account-deletion";
export const ACCOUNT_SIGN_OUT_FENCE_KEY = "chapterline:account-sign-out-fence";
export const SIGN_OUT_REPORT_KEY = "chapterline:sign-out-report";
/** Where this device's Lemonade server listens. Device-local: another device
 * has its own Lemonade, or none, so this must never sync. */
export const LEMONADE_ORIGIN_KEY = "chapterline:lemonade-origin";
export const UNLOAD_PLAYER_EVENT = "chapterline:unload-player";
export const PROGRESS_CONFLICT_EVENT = "chapterline:progress-conflict";

export type UnloadPlayerDetail = {
  userId: string;
  bookId: string;
};
