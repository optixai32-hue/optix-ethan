/**
 * Built-in tools registration — TypeScript port of
 * backend/onyx/tools/built_in_tools.py (the registry bootstrap that
 * instantiates the built-in tool set) onto the static Tool registry
 * (src/tools/registry.ts).
 *
 * Idempotent: each tool is registered only when absent, so calling this at
 * module load or per-request is safe.
 */

import { getTool, registerTool } from "./registry.js";
import { searchTool } from "./implementations/search_tool.js";
import { webSearchTool } from "./implementations/web_search.js";
import { imageGenTool } from "./implementations/image_gen.js";

/** Register the built-in tools exactly once each. */
export function registerBuiltInTools(): void {
  for (const tool of [searchTool, webSearchTool, imageGenTool]) {
    if (!getTool(tool.id)) {
      registerTool(tool);
    }
  }
}
