/**
 * Persona routes — TypeScript port of
 * backend/onyx/server/features/persona/api.py basic_router (prefix /persona):
 *   GET  /persona         -> GET  /        list_personas (MinimalPersonaSnapshot[])
 *   GET  /persona/labels  -> GET  /labels  get_labels (PersonaLabelSnapshot[])
 *   GET  /persona/{id}    -> GET  /:id     get_persona (PersonaSnapshot)
 *   POST /persona         -> POST /        create_persona (admin surface)
 *
 * Shapes follow server/features/persona/models.py MinimalPersonaSnapshot (209)
 * and PersonaSnapshot (327); permission stamping follows
 * auth/permission_projection.py persona_permissions; access level follows
 * db/enums.py PersonaAccessLevel (admins report EDITOR unless owner).
 * The unified default assistant lives at id 0 (DEFAULT_PERSONA_ID).
 */

import { Hono } from "hono";
import { z } from "zod";
import { getLogger } from "../../utils/logger.js";
import { InvalidRequestError } from "../../utils/errors.js";
import { registerBuiltInTools } from "../../tools/built_in_tools.js";
import { builtinToolSnapshots } from "./tools.js";
import { getAuthContext } from "./chat.js";
import { query, queryOne } from "../../db/client.js";
import type { User } from "../../types/domain.js";

const logger = getLogger("routes.persona");

try {
  registerBuiltInTools();
} catch (err) {
  logger.warning("built-in tool registration failed", { error: String(err) });
}

/** Built-in tools attached to the default assistant (persona 0).
 *  Mirrors upstream behavior where the default assistant has the built-in
 *  tool set attached (SearchTool / WebSearchTool / ImageGenerationTool) via
 *  persona__tool; the frontend uses these to drive the Deep Research toggle
 *  (hasSearchToolsAvailable) and the tools affordances. */
function personaTools(): Record<string, unknown>[] {
  try {
    return builtinToolSnapshots();
  } catch {
    return [];
  }
}

type PersonaListRow = {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  is_public: boolean;
  builtin_persona: boolean;
  is_listed: boolean;
  is_featured: boolean;
  deleted: boolean;
  display_priority: number | null;
  icon_name: string | null;
  uploaded_image_id: string | null;
  starter_messages: Array<{ name: string; message: string }> | null;
  user_id: string | null;
  default_model_configuration_id: number | null;
};

const PERSONA_COLUMNS = `id, name, description, system_prompt, is_public,
  builtin_persona, is_listed, is_featured, deleted, display_priority,
  icon_name, uploaded_image_id, starter_messages, user_id,
  default_model_configuration_id`;

function isAdmin(user: User): boolean {
  return user.role === "admin";
}

/**
 * Port of MinimalPersonaSnapshot.from_model + list-endpoint permission
 * stamping for a fresh single-tenant deployment: no labels, no owner
 * (builtins are ownerless), no document sets / knowledge, no tools.
 */
function toMinimalPersonaSnapshot(
  row: PersonaListRow,
  user: User,
): Record<string, unknown> {
  const admin = isAdmin(user);
  const isOwner = row.user_id === user.id;
  const builtin = row.builtin_persona;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tools: personaTools(),
    starter_messages: row.starter_messages ?? null,
    document_sets: [],
    hierarchy_node_count: 0,
    attached_document_count: 0,
    knowledge_sources: [],
    default_model_configuration_id: row.default_model_configuration_id,
    uploaded_image_id: row.uploaded_image_id,
    icon_name: row.icon_name,
    is_public: row.is_public,
    is_listed: row.is_listed,
    display_priority: row.display_priority,
    is_featured: row.is_featured,
    builtin_persona: builtin,
    labels: [],
    owner: null,
    owner_group: null,
    // PersonaAccessLevel: OWNER outranks; admins report EDITOR unless owner.
    user_permission: isOwner ? "OWNER" : admin ? "EDITOR" : "VIEWER",
    // persona_permissions (auth/permission_projection.py:59)
    permissions: {
      edit: isOwner || admin,
      share: isOwner || admin,
      view_stats: admin,
      // Built-ins cannot be deleted (db/persona.py mark_persona_as_deleted guard)
      delete: !builtin && (isOwner || admin),
      publish: isOwner || admin,
      feature: admin,
      list: admin,
      reorder: admin,
    },
  };
}

export const personasRoutes = new Hono();

personasRoutes.get("/", async (c) => {
  let user: User;
  try {
    user = (await getAuthContext(c)).user;
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }

  // Port of get_minimal_persona_snapshots_for_user (basic surface): non-deleted
  // personas visible to the caller, display_priority ASC NULLS LAST, id ASC.
  const res = await query<PersonaListRow>(
    `SELECT ${PERSONA_COLUMNS} FROM persona
     WHERE deleted = false
     ORDER BY display_priority ASC NULLS LAST, id ASC`,
  );
  const visible = res.rows.filter(
    (row) => row.is_public || row.is_listed || row.user_id === user.id || isAdmin(user),
  );

  logger.debug("listing personas", { count: visible.length });
  return c.json(visible.map((row) => toMinimalPersonaSnapshot(row, user)));
});

// GET /persona/labels — port of get_labels (PersonaLabelSnapshot[]).
// No labels exist on a fresh deployment.
personasRoutes.get("/labels", async (c) => {
  try {
    await getAuthContext(c);
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  return c.json([]);
});

personasRoutes.get("/:id", async (c) => {
  let user: User;
  try {
    user = (await getAuthContext(c)).user;
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  const rawId = c.req.param("id");
  const id = Number.parseInt(rawId, 10);
  if (Number.isNaN(id)) {
    throw new InvalidRequestError("Persona id must be an integer");
  }

  const row = await queryOne<PersonaListRow>(
    `SELECT ${PERSONA_COLUMNS} FROM persona WHERE id = $1 AND deleted = false`,
    [id],
  );
  if (!row) {
    return c.json({ detail: "Not Found" }, 404);
  }

  const admin = isAdmin(user);
  const isOwner = row.user_id === user.id;
  return c.json({
    // PersonaSnapshot (server/features/persona/models.py:327)
    ...toMinimalPersonaSnapshot(row, user),
    user_file_ids: [],
    users: [],
    groups: [],
    user_shares: [],
    group_shares: [],
    public_permission: "VIEWER",
    sharing_status: row.is_public ? "PUBLIC" : "PRIVATE",
    hierarchy_nodes: [],
    attached_documents: [],
    system_prompt: row.system_prompt,
    replace_base_system_prompt: false,
    task_prompt: null,
    datetime_aware: true,
  });
});

const createPersonaSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  system_prompt: z.string().optional(),
  is_public: z.boolean().optional(),
  starter_messages: z
    .array(z.object({ name: z.string(), message: z.string() }))
    .nullish(),
});

personasRoutes.post("/", async (c) => {
  let user: User;
  try {
    user = (await getAuthContext(c)).user;
  } catch {
    return c.json({ detail: "Unauthorized" }, 401);
  }
  if (!isAdmin(user)) {
    // create_persona requires manage-agents permission
    return c.json(
      { detail: "You do not have permission to perform this action" },
      403,
    );
  }
  let body: z.infer<typeof createPersonaSchema>;
  try {
    body = createPersonaSchema.parse(await c.req.json());
  } catch (err) {
    throw new InvalidRequestError(
      `Invalid persona create request: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const row = await queryOne<PersonaListRow>(
    `INSERT INTO persona (name, description, system_prompt, is_public, user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${PERSONA_COLUMNS}`,
    [
      body.name,
      body.description ?? "",
      body.system_prompt ?? "",
      body.is_public ?? true,
      user.id,
    ],
  );
  if (!row) {
    return c.json({ detail: "Failed to create persona" }, 500);
  }
  return c.json(toMinimalPersonaSnapshot(row, user), 201);
});
