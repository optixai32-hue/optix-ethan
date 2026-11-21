/** Owned by Task 2-b. Port of backend/onyx/tools/interface.py */
export interface ToolResponse { content: string }
export interface ToolContext { userId: string; chatSessionId?: string; emit?: (packetType: string, message: string) => void }
export interface Tool {
  id: string; name: string; displayName: string; description: string;
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResponse>;
}
