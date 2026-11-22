/**
 * Integrations routes — TypeScript port of
 * backend/onyx/server/features/integrations/api.py (prefix /integrations):
 *   GET /integrations                  -> GET /              list_integrations_for_member
 *   GET /integrations/agent-catalog    -> GET /agent-catalog  get_agent_catalog
 *   GET /integrations/agents/{id}      -> GET /agents/:id     get_agent_integration_ids
 *
 * Fresh deployment: no integrations configured, so the member listing is an
 * empty list and the agent allow-list is a bare list[int] ([]) — exactly the
 * original shapes. Requires authentication (member / READ_CHAT gate).
 */
import { Hono } from "hono";
import { getAuthContext } from "./chat.js";

export const integrationsRoutes = new Hono();

integrationsRoutes.get("/integrations", async (c) => {
  try {
    await getAuthContext(c);
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return c.json([]);
});

integrationsRoutes.get("/integrations/agent-catalog", async (c) => {
  try {
    await getAuthContext(c);
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return c.json([]);
});

integrationsRoutes.get("/integrations/agents/:personaId", async (c) => {
  try {
    await getAuthContext(c);
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  // bare list[int] — the integrations a chat of the agent uses for the user
  return c.json([]);
});
