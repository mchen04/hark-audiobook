import { withQuery } from "@/server/api/route-handler";
import { createAccountExportStream } from "@/server/account/export-stream";

export const runtime = "nodejs";

export const GET = withQuery(async ({ session }) => {
  return new Response(
    createAccountExportStream({
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="hark-export-${new Date().toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    },
  );
});
