/** Owned by Task 2-b. Port of backend/onyx/tools/tool_constructor.py */
import type { Tool } from "./interface.js";
const registry = new Map<string, Tool>();
export function registerTool(tool: Tool): void { registry.set(tool.id, tool); }
export function getTool(id: string): Tool | undefined { return registry.get(id); }
export function listTools(): Tool[] { return [...registry.values()]; }
