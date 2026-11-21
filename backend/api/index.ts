/**
 * Vercel serverless entry — mounts the same Hono app as the Bun entry
 * (src/index.ts) on the Node runtime.
 *
 * Routing model: the frontend (web) calls this service with paths prefixed
 * by /api (INTERNAL_URL = https://<host>/api). api/index.ts maps to /api
 * and api/[...path].ts maps to /api/<sub-path>; the handler strips the
 * /api prefix and dispatches to the Hono app (routes: /auth, /settings, ...).
 *
 * Vercel function signature: named `fetch`/HTTP-method exports using the Web
 * API (Request -> Response). The default export uses the legacy (req, res)
 * signature on @vercel/node and IGNORES returned Responses — do not use it.
 */
import { app } from "../src/server/app";
import { ensureServerlessInit } from "../src/server/vercel_init";

export const config = { runtime: "nodejs" };

type Handler = (req: Request) => Response | Promise<Response>;

const API_PREFIX = "/api";

export const vercelHandler: Handler = async (req: Request) => {
  try {
    await ensureServerlessInit();
    // req.url may be absolute or path-only depending on the runtime — pass a
    // base so `new URL` always succeeds.
    const url = new URL(req.url, "https://vercel-internal.local");
    let path = url.pathname;
    if (path === API_PREFIX) {
      path = "/";
    } else if (path.startsWith(API_PREFIX + "/")) {
      path = path.slice(API_PREFIX.length);
    }
    if (path !== url.pathname) {
      url.pathname = path;
      return await app.fetch(new Request(url.toString(), req));
    }
    return await app.fetch(req);
  } catch (err: unknown) {
    const stack = err instanceof Error ? err.stack : String(err);
    console.error("vercel handler error:", stack);
    return new Response(
      JSON.stringify({ detail: "function_error", error: String(err), stack }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }
};

export const fetch = vercelHandler;
export const GET = vercelHandler;
export const POST = vercelHandler;
export const PUT = vercelHandler;
export const PATCH = vercelHandler;
export const DELETE = vercelHandler;
export const HEAD = vercelHandler;
export const OPTIONS = vercelHandler;
