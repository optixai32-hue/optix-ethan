import { cookies, headers } from "next/headers";
import { HOST_URL, INTERNAL_URL } from "./constants";
import { processCookies } from "@/lib/users/svcSS";

export function buildClientUrl(path: string) {
  if (path.startsWith("/")) {
    return `${HOST_URL}${path}`;
  }
  return `${HOST_URL}/${path}`;
}

/**
 * Resolve the backend base URL at REQUEST time.
 *
 * On Vercel single deployments the TS backend runs in-process behind this
 * deployment's own public /api surface. The public hostname is taken from the
 * incoming request headers (x-forwarded-host): the production alias domain is
 * NOT behind Vercel Authentication, whereas the unique VERCEL_URL hostname IS
 * (its auth-wall HTML page would poison every server-side JSON parse).
 *
 * Outside a request scope (build-time evaluation, module init) fall back to
 * env vars, and to the classic INTERNAL_URL for split deployments.
 */
export async function getInternalBaseUrl(): Promise<string> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) {
      const proto =
        h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
      return `${proto}://${host}/api`;
    }
  } catch {
    // Not in a request scope (generateStaticParams, module init, ...).
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/api`;
  }
  return process.env.INTERNAL_URL || "http://localhost:8080";
}

/** Async counterpart of buildUrl — resolves against the live request host. */
export async function buildUrlAsync(path: string): Promise<string> {
  const base = await getInternalBaseUrl();
  if (path.startsWith("/")) {
    return `${base}${path}`;
  }
  return `${base}/${path}`;
}

export function buildUrl(path: string) {
  if (path.startsWith("/")) {
    return `${INTERNAL_URL}${path}`;
  }
  return `${INTERNAL_URL}/${path}`;
}

export class UrlBuilder {
  private url: URL;

  constructor(baseUrl: string) {
    try {
      this.url = new URL(baseUrl);
    } catch {
      // Handle relative URLs by prepending a base
      this.url = new URL(baseUrl, "http://placeholder.com");
    }
  }

  addParam(key: string, value: string | number | boolean): UrlBuilder {
    this.url.searchParams.set(key, String(value));
    return this;
  }

  addParams(params: Record<string, string | number | boolean>): UrlBuilder {
    Object.entries(params).forEach(([key, value]) => {
      this.url.searchParams.set(key, String(value));
    });
    return this;
  }

  toString(): string {
    // Extract just the path and query parts for relative URLs
    if (this.url.origin === "http://placeholder.com") {
      return `${this.url.pathname}${this.url.search}`;
    }
    return this.url.toString();
  }

  static fromInternalUrl(path: string): UrlBuilder {
    return new UrlBuilder(buildUrl(path));
  }

  static fromClientUrl(path: string): UrlBuilder {
    return new UrlBuilder(buildClientUrl(path));
  }
}

export async function fetchSS(url: string, options?: RequestInit) {
  const cookieString = processCookies(await cookies());

  const init: RequestInit = {
    credentials: "include",
    cache: "no-store",
    ...options,
    headers: {
      ...options?.headers,
      cookie: cookieString,
    },
  };

  return fetch(await buildUrlAsync(url), init);
}
