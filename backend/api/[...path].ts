/**
 * Vercel catch-all for /api/<sub-path> — delegates to the same handler as
 * api/index.ts (api/index.ts maps to /api exactly; this file to /api/<anything>).
 */
import { vercelHandler } from "./index";

export const config = { runtime: "nodejs" };

export const fetch = vercelHandler;
export const GET = vercelHandler;
export const POST = vercelHandler;
export const PUT = vercelHandler;
export const PATCH = vercelHandler;
export const DELETE = vercelHandler;
export const HEAD = vercelHandler;
export const OPTIONS = vercelHandler;
