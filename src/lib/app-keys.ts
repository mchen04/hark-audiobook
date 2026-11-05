export const ACTIVE_USER_KEY = "chapterline:active-user";
export const PENDING_ACCOUNT_DELETION_KEY = "chapterline:pending-account-deletion";
export const ACCOUNT_SIGN_OUT_FENCE_KEY = "chapterline:account-sign-out-fence";
export const SIGN_OUT_REPORT_KEY = "chapterline:sign-out-report";
export const UNLOAD_PLAYER_EVENT = "chapterline:unload-player";
export const PROGRESS_CONFLICT_EVENT = "chapterline:progress-conflict";

export type UnloadPlayerDetail = {
  userId: string;
  bookId: string;
};
