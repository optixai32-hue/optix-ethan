/**
 * EE standard answers — Task 4. Port of
 * backend/onyx/server/manage/standard_answer/api.py (router prefix "/manage",
 * EE-only surface).
 *
 * Frontend contract (verified against /home/z/onyx/web/src):
 *   - GET  /manage/admin/standard-answer            -> StandardAnswer[]
 *     (web/src/lib/types.ts:489 {id, keyword, answer, match_regex,
 *      match_any_keywords, categories: {id, name}[]})
 *   - POST /manage/admin/standard-answer            -> StandardAnswerCreationRequest
 *     (web/src/app/ee/admin/standard-answer/lib.ts: {keyword, answer,
 *      categories: number[], match_regex, match_any_keywords})
 *   - PATCH/PUT /manage/admin/standard-answer/:id   -> same body (update)
 *   - DELETE /manage/admin/standard-answer/:id      -> soft delete ("deleted")
 *   - GET  /manage/admin/standard-answer/category   -> {id, name}[]
 *   - POST /manage/admin/standard-answer/category   -> {name}
 *   - PATCH /manage/admin/standard-answer/category/:id -> {name}
 *
 * Backed by the standard_answer / standard_answer_category /
 * standard_answer__category tables (migration 0011).
 */
import { Hono, type Context } from "hono";
import { requireAdmin } from "../../auth/middleware.js";
import { query, queryOne, withTransaction } from "../../db/client.js";
import { InvalidRequestError, NotFoundError } from "../../utils/errors.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger("server.routes.standard_answers");

export const standardAnswerRoutes = new Hono();

interface StandardAnswerRow {
  id: number;
  keyword: string;
  answer: string;
  match_regex: boolean;
  match_any_keywords: boolean;
  deleted: boolean;
  created_at: Date;
  updated_at: Date;
}

interface StandardAnswerCategoryRow {
  id: number;
  name: string;
}

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Attach the category list ({id, name}[]) to a StandardAnswer row. */
async function buildStandardAnswerPayload(
  row: StandardAnswerRow,
): Promise<Record<string, unknown>> {
  const categories = await query<StandardAnswerCategoryRow>(
    `SELECT c.id, c.name
     FROM standard_answer__category sac
     JOIN standard_answer_category c ON c.id = sac.standard_answer_category_id
     WHERE sac.standard_answer_id = $1
     ORDER BY c.id ASC`,
    [row.id],
  );
  return {
    id: row.id,
    keyword: row.keyword,
    answer: row.answer,
    match_regex: row.match_regex,
    match_any_keywords: row.match_any_keywords,
    categories: categories.rows.map((c) => ({ id: c.id, name: c.name })),
    deleted: row.deleted,
  };
}

async function fetchAnswerRow(id: number): Promise<StandardAnswerRow> {
  const row = await queryOne<StandardAnswerRow>(
    `SELECT id, keyword, answer, match_regex, match_any_keywords, deleted,
            created_at, updated_at
     FROM standard_answer WHERE id = $1`,
    [id],
  );
  if (!row) throw new NotFoundError("Standard answer");
  return row;
}

async function fetchCategoryRow(id: number): Promise<StandardAnswerCategoryRow> {
  const row = await queryOne<StandardAnswerCategoryRow>(
    `SELECT id, name FROM standard_answer_category WHERE id = $1`,
    [id],
  );
  if (!row) throw new NotFoundError("Standard answer category");
  return row;
}

/** Validate + normalize the shared create/update body. */
function parseAnswerBody(
  body: Record<string, unknown>,
): {
  keyword: string;
  answer: string;
  categoryIds: number[];
  matchRegex: boolean;
  matchAnyKeywords: boolean;
} {
  const keyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
  const answer = typeof body.answer === "string" ? body.answer : "";
  if (!keyword || !answer) {
    throw new InvalidRequestError("keyword and answer are required");
  }
  const matchRegex = body.match_regex === true;
  const matchAnyKeywords = body.match_any_keywords === true;
  const rawCategories = Array.isArray(body.categories) ? body.categories : [];
  const categoryIds = rawCategories
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);
  return { keyword, answer, categoryIds, matchRegex, matchAnyKeywords };
}

async function replaceAnswerCategories(
  answerId: number,
  categoryIds: number[],
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `DELETE FROM standard_answer__category WHERE standard_answer_id = $1`,
      [answerId],
    );
    for (const categoryId of categoryIds) {
      await client.query(
        `INSERT INTO standard_answer__category
           (standard_answer_id, standard_answer_category_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [answerId, categoryId],
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Standard answers (mounted at /manage — see src/index.ts)
// ---------------------------------------------------------------------------

standardAnswerRoutes.get("/admin/standard-answer", requireAdmin, async (c) => {
  const res = await query<StandardAnswerRow>(
    `SELECT id, keyword, answer, match_regex, match_any_keywords, deleted,
            created_at, updated_at
     FROM standard_answer
     ORDER BY id ASC`,
  );
  const answers = await Promise.all(
    res.rows.map((row) => buildStandardAnswerPayload(row)),
  );
  return c.json(answers);
});

standardAnswerRoutes.post("/admin/standard-answer", requireAdmin, async (c) => {
  const body = await readJson(c);
  const parsed = parseAnswerBody(body);
  const created = await withTransaction(async (client) => {
    const inserted = await client.query<StandardAnswerRow>(
      `INSERT INTO standard_answer
         (keyword, answer, match_regex, match_any_keywords)
       VALUES ($1, $2, $3, $4)
       RETURNING id, keyword, answer, match_regex, match_any_keywords, deleted,
                 created_at, updated_at`,
      [parsed.keyword, parsed.answer, parsed.matchRegex, parsed.matchAnyKeywords],
    );
    const row = inserted.rows[0];
    for (const categoryId of parsed.categoryIds) {
      await client.query(
        `INSERT INTO standard_answer__category
           (standard_answer_id, standard_answer_category_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [row.id, categoryId],
      );
    }
    return row;
  });
  return c.json(await buildStandardAnswerPayload(created));
});

// PATCH (frontend lib.ts) and PUT (task spec) share the update semantics.
async function updateStandardAnswer(c: Context) {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    throw new NotFoundError("Standard answer");
  }
  await fetchAnswerRow(id);
  const body = await readJson(c);
  const parsed = parseAnswerBody(body);
  const updated = await queryOne<StandardAnswerRow>(
    `UPDATE standard_answer
     SET keyword = $2, answer = $3, match_regex = $4,
         match_any_keywords = $5, updated_at = now()
     WHERE id = $1
     RETURNING id, keyword, answer, match_regex, match_any_keywords, deleted,
               created_at, updated_at`,
    [id, parsed.keyword, parsed.answer, parsed.matchRegex, parsed.matchAnyKeywords],
  );
  if (!updated) throw new NotFoundError("Standard answer");
  await replaceAnswerCategories(id, parsed.categoryIds);
  return c.json(await buildStandardAnswerPayload(updated));
}
standardAnswerRoutes.patch("/admin/standard-answer/:id", requireAdmin, updateStandardAnswer);
standardAnswerRoutes.put("/admin/standard-answer/:id", requireAdmin, updateStandardAnswer);

// DELETE — soft delete (StandardAnswer.deleted column, migration 0011).
standardAnswerRoutes.delete("/admin/standard-answer/:id", requireAdmin, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) {
    throw new NotFoundError("Standard answer");
  }
  const row = await queryOne<StandardAnswerRow>(
    `UPDATE standard_answer SET deleted = true, updated_at = now() WHERE id = $1
     RETURNING id, keyword, answer, match_regex, match_any_keywords, deleted,
               created_at, updated_at`,
    [id],
  );
  if (!row) throw new NotFoundError("Standard answer");
  logger.info("standard answer soft-deleted", { id });
  return c.json(null);
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

standardAnswerRoutes.get("/admin/standard-answer/category", requireAdmin, async (c) => {
  const res = await query<StandardAnswerCategoryRow>(
    `SELECT id, name FROM standard_answer_category ORDER BY id ASC`,
  );
  return c.json(res.rows.map((r) => ({ id: r.id, name: r.name })));
});

standardAnswerRoutes.post("/admin/standard-answer/category", requireAdmin, async (c) => {
  const body = await readJson(c);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    throw new InvalidRequestError("name is required");
  }
  const created = await queryOne<StandardAnswerCategoryRow>(
    `INSERT INTO standard_answer_category (name) VALUES ($1)
     RETURNING id, name`,
    [name],
  );
  return c.json(created);
});

standardAnswerRoutes.patch(
  "/admin/standard-answer/category/:id",
  requireAdmin,
  async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) {
      throw new NotFoundError("Standard answer category");
    }
    await fetchCategoryRow(id);
    const body = await readJson(c);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      throw new InvalidRequestError("name is required");
    }
    const updated = await queryOne<StandardAnswerCategoryRow>(
      `UPDATE standard_answer_category SET name = $2, updated_at = now()
       WHERE id = $1 RETURNING id, name`,
      [id, name],
    );
    if (!updated) throw new NotFoundError("Standard answer category");
    return c.json(updated);
  },
);
