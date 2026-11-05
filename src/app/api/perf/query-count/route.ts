import { queryCountingEnabled, readQueryCount, resetQueryCount } from "@/server/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  if (!queryCountingEnabled) return new Response("Not found", { status: 404 });
  const count = readQueryCount();
  if (new URL(request.url).searchParams.get("reset") === "1") resetQueryCount();
  return Response.json(
    { count },
    { headers: { "cache-control": "no-store, no-cache, must-revalidate" } },
  );
}
