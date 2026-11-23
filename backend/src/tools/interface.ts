/** Owned by Task 2-b. Port of backend/onyx/tools/interface.py */
export interface ToolResponse { content: string }
/**
 * `mergeIntoThinking` (TS port extension): set by the agent loop for tools
 * whose progress must render INSIDE the cycle's existing "Thinking" step
 * (ReasoningRenderer group) instead of opening their own timeline step.
 * When true, tools replace their step-opening packets (SearchToolStart...)
 * with reasoning_delta status lines — no separate step is created.
 */
export interface ToolContext {
  userId: string;
  chatSessionId?: string;
  emit?: (packetType: string, message: string) => void;
  mergeIntoThinking?: boolean;
}
export interface Tool {
  id: string; name: string; displayName: string; description: string;
  inputSchema: Record<string, unknown>;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResponse>;
}
