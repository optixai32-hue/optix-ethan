/**
 * Personas / Assistants — TypeScript port of the persona access layer:
 * backend/onyx/db/persona.py (get personas by id / default behavior persona /
 * create persona) and backend/onyx/db/models.py :: Persona.
 *
 * SQL targets the persona table owned by Task 2-a's migrations:
 *   persona(id serial, name, description, system_prompt,
 *           llm_model_version_override, is_public, created_at, updated_at)
 *
 * Default persona policy: Onyx's DEFAULT_PERSONA_ID is 0
 * (backend/onyx/configs/constants.py line 72); this port tries id 1 first
 * (the seeded default in onyx-ts), falls back to the first persona row, and
 * finally returns an in-memory default mirroring DEFAULT_SYSTEM_PROMPT
 * (backend/onyx/prompts/chat_prompts.py lines 28-53) when the table is empty.
 */

import { query, queryOne } from "../db/client";
import type { Persona } from "../types/domain";
import { NotFoundError } from "../utils/errors";

// Row type is a type alias so it satisfies pg's QueryResultRow constraint.
type PersonaRow = {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  llm_model_version_override: string | null;
  is_public: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

function normalizePersona(row: PersonaRow): Persona {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    system_prompt: row.system_prompt,
    llm_model_version_override: row.llm_model_version_override,
    is_public: row.is_public,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

/** In-memory fallback persona (DEFAULT_PERSONA_ID = 0 semantics). */
export const BUILT_IN_DEFAULT_PERSONA: Persona = {
  id: 0,
  name: "Default assistant",
  description: "A helpful, truthful assistant grounded in the user's documents.",
  system_prompt: `You are an expert assistant who is truthful, nuanced, insightful, and efficient. Your goal is to deeply understand the user's intent, think step-by-step through complex problems, provide clear and accurate answers, and proactively anticipate helpful follow-up information. Whenever there is any ambiguity around the user's query (or more information would be helpful), you use available tools (if any) to get more context.

# Response Style
You use different text styles, bolding, block quotes, and other formatting to make your responses more readable and engaging.
You use proper Markdown and LaTeX to format your responses for math, scientific, and chemical formulas, symbols, etc.: '$$\\n[expression]\\n$$' for standalone cases and '\\( [expression] \\)' when inline.
For code you prefer to use Markdown and specify the language.`,
  llm_model_version_override: null,
  is_public: true,
  created_at: new Date(0),
  updated_at: new Date(0),
};

/**
 * The default persona: DEFAULT_PERSONA_ID = 0 (configs/constants.py:72) — the
 * unified builtin "Assistant" seeded by migration 0002, else the first
 * non-deleted persona row, else the built-in default (port of
 * get_default_behavior_persona's fallback to DEFAULT_SYSTEM_PROMPT).
 */
export async function getDefaultPersona(): Promise<Persona> {
  const byId = await queryOne<PersonaRow>(
    `SELECT id, name, description, system_prompt, llm_model_version_override, is_public, created_at, updated_at
     FROM persona WHERE id = 0`,
  );
  if (byId) return normalizePersona(byId);
  const first = await queryOne<PersonaRow>(
    `SELECT id, name, description, system_prompt, llm_model_version_override, is_public, created_at, updated_at
     FROM persona ORDER BY id ASC LIMIT 1`,
  );
  if (first) return normalizePersona(first);
  return BUILT_IN_DEFAULT_PERSONA;
}

/** Fetch a persona by id (port of get_persona_by_id). */
export async function getPersona(personaId: number): Promise<Persona> {
  const row = await queryOne<PersonaRow>(
    `SELECT id, name, description, system_prompt, llm_model_version_override, is_public, created_at, updated_at
     FROM persona WHERE id = $1`,
    [personaId],
  );
  if (!row) {
    throw new NotFoundError("Persona");
  }
  return normalizePersona(row);
}

/** List personas, public ones first (assistants surface). */
export async function listPersonas(): Promise<Persona[]> {
  const res = await query<PersonaRow>(
    `SELECT id, name, description, system_prompt, llm_model_version_override, is_public, created_at, updated_at
     FROM persona ORDER BY is_public DESC, id ASC`,
  );
  return res.rows.map(normalizePersona);
}

export interface CreatePersonaInput {
  name: string;
  description?: string;
  systemPrompt?: string;
  llmModelVersionOverride?: string | null;
  isPublic?: boolean;
}

/** Create a persona (port of create_persona in db/persona.py). */
export async function createPersona(input: CreatePersonaInput): Promise<Persona> {
  const row = await queryOne<PersonaRow>(
    `INSERT INTO persona (name, description, system_prompt, llm_model_version_override, is_public, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     RETURNING id, name, description, system_prompt, llm_model_version_override, is_public, created_at, updated_at`,
    [
      input.name,
      input.description ?? "",
      input.systemPrompt ?? BUILT_IN_DEFAULT_PERSONA.system_prompt,
      input.llmModelVersionOverride ?? null,
      input.isPublic ?? true,
    ],
  );
  if (!row) {
    throw new Error("persona insert returned no row");
  }
  return normalizePersona(row);
}
