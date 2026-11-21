import { SERVER_SIDE_ONLY__AUTH_COOKIE_NAME } from "@/lib/constants";
import { INTERNAL_URL } from "@/lib/constants";
import { NextRequest, NextResponse } from "next/server";

/*
 * Backend surface — dual mode:
 *
 *  1. Split deployment (default local / self-hosted behind nginx): /api/* is
 *     proxied over HTTP to the standalone backend at INTERNAL_URL.
 *
 *  2. Single deployment (Vercel): the TS backend (Hono app, repo sibling
 *     `backend/`) runs IN-PROCESS inside this Next.js function. No separate
 *     backend host exists — requests are dispatched directly to the Hono app
 *     via app.fetch(), and server-side callers reach it through
 *     INTERNAL_URL = https://<VERCEL_URL>/api (see lib/constants.ts).
 *     Detected via the VERCEL_URL system env, which Vercel injects into every
 *     function instance.
 */

console.log("[DIAG] route module evaluated, IS_VERCEL_RUNTIME next");

const IS_VERCEL_RUNTIME = Boolean(
  process.env.VERCEL_URL || process.env.VERCEL === "1"
);

/* NextJS is annoying and makes use use a separate function for
each request type >:( */

export async function GET(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function PUT(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function PATCH(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function DELETE(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function HEAD(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

export async function OPTIONS(
  request: NextRequest,
  props: { params: Promise<{ path: string[] }> }
) {
  const params = await props.params;
  return handleRequest(request, params.path);
}

// In-process backend bundle — loaded lazily on first request so route module
// evaluation stays cheap and import failures surface as a clean 500.
type HonoApp = { fetch: (req: Request) => Response | Promise<Response> };
let backendBundlePromise: Promise<{ app: HonoApp }> | null = null;

function loadBackendBundle(): Promise<{ app: HonoApp }> {
  if (!backendBundlePromise) {
    backendBundlePromise = (async () => {
      const [{ app }, { ensureServerlessInit }] = await Promise.all([
        import("onyx-ts/server/app"),
        import("onyx-ts/server/vercel_init"),
      ]);
      // One-time per-process bootstrapping: DB migrations + LLM provider
      // seeding (idempotent, fail-open — mirrors the backend's own boot).
      await ensureServerlessInit();
      return { app: app as unknown as HonoApp };
    })().catch((err) => {
      // Never memoize a failed import: the next request retries the load.
      backendBundlePromise = null;
      throw err;
    });
  }
  return backendBundlePromise;
}

/**
 * Dispatch the request to the in-process Hono app (single-deployment mode).
 * The response is rebuilt as a NextResponse so multiple Set-Cookie headers
 * (login/session refresh) and streaming bodies (chat SSE) survive intact.
 */
async function dispatchInProcess(
  request: NextRequest,
  path: string[]
): Promise<NextResponse> {
  try {
    const { app } = await loadBackendBundle();

    // Rebuild the target URL with only the backend-relative path (strip the
    // /api prefix) plus the original query string.
    const incoming = new URL(request.url);
    const target = new URL("/", incoming.origin);
    target.pathname = `/${path.join("/")}`;
    target.search = incoming.search;

    // Hop-by-hop / re-encoded headers must not leak into the sub-request.
    const headers = new Headers(request.headers);
    headers.delete("connection");
    headers.delete("keep-alive");
    headers.delete("transfer-encoding");
    headers.delete("upgrade");

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    let body: ArrayBuffer | undefined;
    if (hasBody) {
      body = await request.arrayBuffer();
      if (body.byteLength === 0) {
        body = undefined;
        headers.delete("content-length");
      }
    } else {
      headers.delete("content-length");
    }

    const honoRes = await app.fetch(
      new Request(target.toString(), {
        method: request.method,
        headers,
        body,
      })
    );

    // Preserve every Set-Cookie (fastapiusersauth session etc.).
    const setCookies = honoRes.headers.getSetCookie?.() ?? [];
    const responseHeaders = new Headers(honoRes.headers);
    responseHeaders.delete("set-cookie");

    const contentType = responseHeaders.get("content-type") ?? "";
    if (contentType.includes("stream") || responseHeaders.get("transfer-encoding")) {
      responseHeaders.delete("content-length");
      responseHeaders.set("Cache-Control", "no-cache, no-transform");
      responseHeaders.set("X-Accel-Buffering", "no");
    }

    const response = new NextResponse(honoRes.body, {
      status: honoRes.status,
      headers: responseHeaders,
    });
    for (const cookie of setCookies) {
      if (cookie) {
        response.headers.append("set-cookie", cookie);
      }
    }
    return response;
  } catch (error: unknown) {
    console.error("In-process backend dispatch error:", error);
    return NextResponse.json(
      {
        message: "Backend dispatch error",
        error:
          error instanceof Error ? error.message : "An unknown error occurred",
      },
      { status: 500 }
    );
  }
}

async function proxyToBackend(
  request: NextRequest,
  path: string[]
): Promise<NextResponse> {
  if (
    process.env.NODE_ENV !== "development" &&
    // NOTE: Set this environment variable to 'true' for preview environments
    // Where you want finer-grained control over API access
    process.env.OVERRIDE_API_PRODUCTION !== "true"
  ) {
    return NextResponse.json(
      {
        message:
          "This API is only available in development mode. In production, something else (e.g. nginx) should handle this.",
      },
      { status: 404 }
    );
  }

  try {
    const backendUrl = new URL(`${INTERNAL_URL}/${path.join("/")}`);

    // Get the URL parameters from the request
    const urlParams = new URLSearchParams(request.url.split("?")[1]);

    // Append the URL parameters to the backend URL
    urlParams.forEach((value, key) => {
      backendUrl.searchParams.append(key, value);
    });

    // Build headers, optionally injecting debug auth cookie
    const headers = new Headers(request.headers);
    if (
      process.env.DEBUG_AUTH_COOKIE &&
      process.env.NODE_ENV === "development"
    ) {
      // Inject the debug auth cookie for local development against remote backend
      // Get from cloud site: DevTools → Application → Cookies → <AUTH_COOKIE_NAME, default: fastapiusersauth>
      const existingCookies = headers.get("cookie") || "";
      const debugCookie = `${SERVER_SIDE_ONLY__AUTH_COOKIE_NAME}=${process.env.DEBUG_AUTH_COOKIE}`;
      headers.set(
        "cookie",
        existingCookies ? `${existingCookies}; ${debugCookie}` : debugCookie
      );
    }

    const response = await fetch(backendUrl, {
      method: request.method,
      headers: headers,
      body: request.body,
      signal: request.signal,
      redirect: "manual",
      // @ts-expect-error -- RequestInit lacks `duplex`; Node fetch needs it to stream the request body.
      duplex: "half",
    });

    const setCookies =
      // @ts-ignore - undici provides getSetCookie in Node.
      response.headers.getSetCookie?.() ??
      (response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie")]
        : []);

    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("set-cookie");

    // Check if the response is a stream
    if (
      response.headers.get("Transfer-Encoding") === "chunked" ||
      response.headers.get("Content-Type")?.includes("stream")
    ) {
      responseHeaders.set("Cache-Control", "no-cache, no-transform");
      responseHeaders.set("X-Accel-Buffering", "no");
      responseHeaders.delete("content-length");

      const proxyResponse = new NextResponse(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
      for (const cookie of setCookies) {
        if (cookie) {
          proxyResponse.headers.append("set-cookie", cookie);
        }
      }
      return proxyResponse;
    } else {
      const proxyResponse = new NextResponse(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
      for (const cookie of setCookies) {
        if (cookie) {
          proxyResponse.headers.append("set-cookie", cookie);
        }
      }
      return proxyResponse;
    }
  } catch (error: unknown) {
    console.error("Proxy error:", error);
    return NextResponse.json(
      {
        message: "Proxy error",
        error:
          error instanceof Error ? error.message : "An unknown error occurred",
      },
      { status: 500 }
    );
  }
}

async function handleRequest(request: NextRequest, path: string[]) {
  console.log("[DIAG] handleRequest hit:", request.method, path.join("/"));
  if (path[0] === "__diag") {
    return NextResponse.json({ ok: true, path, ts: new Date().toISOString() });
  }
  if (IS_VERCEL_RUNTIME) {
    // Single deployment: the backend lives inside this function.
    return dispatchInProcess(request, path);
  }
  return proxyToBackend(request, path);
}
