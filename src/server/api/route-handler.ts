import "server-only";

import { z } from "zod";

import { auth } from "@/server/auth";
import { SyncBusyError } from "@/server/db/sync-receipt";
import { isTrustedMutationOrigin } from "@/server/security/request-origin";

type RouteSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

type RouteArgs = { params: Promise<unknown> };

type QueryContext<P> = { request: Request; session: RouteSession; params: P };
type MutationContext<P, D> = QueryContext<P> & { data: D };

type RouteHandler = (request: Request, routeArgs?: RouteArgs) => Promise<Response>;

export function withQuery<P = Record<string, never>>(
  handler: (context: QueryContext<P>) => Promise<Response>,
): RouteHandler;
export function withQuery<PS extends z.ZodType>(
  options: { params: PS },
  handler: (context: QueryContext<z.infer<PS>>) => Promise<Response>,
): RouteHandler;
export function withQuery(
  first: { params: z.ZodType } | ((context: never) => Promise<Response>),
  second?: (context: never) => Promise<Response>,
): RouteHandler {
  const paramsSchema = typeof first === "function" ? undefined : first.params;
  const handler = (typeof first === "function" ? first : second!) as (
    context: QueryContext<unknown>,
  ) => Promise<Response>;
  return async (request, routeArgs) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const params = await resolveParams(paramsSchema, routeArgs);
    if (params.kind === "invalid") return Response.json({ error: "Not found" }, { status: 404 });
    return handler({ request, session, params: params.value });
  };
}

export function withMutation<P = Record<string, never>>(
  handler: (context: QueryContext<P>) => Promise<Response>,
): RouteHandler;
export function withMutation<PS extends z.ZodType, BS extends z.ZodType>(
  options: { params: PS; body: BS; invalidBody: string },
  handler: (context: MutationContext<z.infer<PS>, z.infer<BS>>) => Promise<Response>,
): RouteHandler;
export function withMutation<BS extends z.ZodType>(
  options: { body: BS; invalidBody: string },
  handler: (context: MutationContext<Record<string, never>, z.infer<BS>>) => Promise<Response>,
): RouteHandler;
export function withMutation<PS extends z.ZodType>(
  options: { params: PS },
  handler: (context: QueryContext<z.infer<PS>>) => Promise<Response>,
): RouteHandler;
export function withMutation(
  first:
    | { params?: z.ZodType; body?: z.ZodType; invalidBody?: string }
    | ((context: never) => Promise<Response>),
  second?: (context: never) => Promise<Response>,
): RouteHandler {
  const options = typeof first === "function" ? {} : first;
  const { params: paramsSchema, body: bodySchema } = options;
  const invalidBody = options.invalidBody ?? "Invalid request body.";
  const handler = (typeof first === "function" ? first : second!) as (
    context: MutationContext<unknown, unknown>,
  ) => Promise<Response>;
  return async (request, routeArgs) => {
    if (!isTrustedMutationOrigin(request)) {
      return Response.json({ error: "Untrusted request origin." }, { status: 403 });
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const params = await resolveParams(paramsSchema, routeArgs);
    if (params.kind === "invalid") return Response.json({ error: "Not found" }, { status: 404 });
    const context = { request, session, params: params.value, data: undefined as unknown };
    if (bodySchema) {
      const parsed = bodySchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: invalidBody }, { status: 400 });
      context.data = parsed.data;
    }
    try {
      return await handler(context);
    } catch (error) {
      if (!(error instanceof SyncBusyError)) throw error;
      return Response.json(
        { error: error.message },
        { status: 503, headers: { "Retry-After": "1" } },
      );
    }
  };
}

async function resolveParams(
  schema: z.ZodType | undefined,
  routeArgs: RouteArgs | undefined,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" }> {
  const raw = routeArgs ? await routeArgs.params : {};
  if (!schema) return { kind: "ok", value: raw };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { kind: "invalid" };
  return { kind: "ok", value: parsed.data };
}
