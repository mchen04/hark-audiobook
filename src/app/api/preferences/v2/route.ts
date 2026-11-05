import { makePreferencesPatch } from "@/server/preferences/patch-handler";

export const runtime = "nodejs";
export const PATCH = makePreferencesPatch({ strict: true });
