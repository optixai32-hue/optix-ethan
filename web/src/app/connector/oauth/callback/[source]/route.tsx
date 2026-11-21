import { buildUrlAsync } from "@/lib/utilsSS";
import { NextRequest, NextResponse } from "next/server";
import type { ErrorResponseBody } from "@/lib/fetcher";

// TODO: deprecate this and just go directly to the backend via /api/...
// For some reason Egnyte doesn't work when using /api, so leaving this as is for now
// If we do try and remove this, make sure we test the Egnyte connector oauth flow
// Backend `CallbackResponse` on success, or an error body.
interface OAuthCallbackProxyBody extends ErrorResponseBody {
  redirect_url?: string;
}

export async function GET(request: NextRequest) {
  try {
    // NOTE: resolve against the live request host (public alias on Vercel) and
    // keep the /api prefix — otherwise this fetch would re-enter this very
    // route handler instead of reaching the backend.
    const backendUrl = new URL(await buildUrlAsync("/api"));
    // Copy path and query parameters from incoming request
    backendUrl.pathname = `/api${request.nextUrl.pathname}`;
    backendUrl.search = request.nextUrl.search;

    const response = await fetch(backendUrl, {
      method: "GET",
      headers: request.headers,
      signal: request.signal,
    });

    const responseData: OAuthCallbackProxyBody = await response.json();
    if (responseData.redirect_url) {
      return NextResponse.redirect(responseData.redirect_url);
    }

    return new NextResponse(JSON.stringify(responseData), {
      status: response.status,
      headers: response.headers,
    });
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
