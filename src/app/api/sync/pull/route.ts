import { z } from "zod";

import { withQuery } from "@/server/api/route-handler";
import { loadPullBatch } from "@/server/sync/pull";

export const runtime = "nodejs";

const sinceSchema = z.iso.datetime();

export const GET = withQuery(async ({ request, session }) => {
  const query = new URL(request.url).searchParams;
  const since = query.get("since");
  if (since !== null && !sinceSchema.safeParse(since).success) {
    return Response.json({ error: "Invalid sync cursor." }, { status: 400 });
  }
  const finalSnapshotsOnly = query.get("snapshots") === "final";
  const liveBookDigest = query.get("liveBooks");
  return Response.json(
    await loadPullBatch(session.user.id, since, { finalSnapshotsOnly, liveBookDigest }),
  );
});
