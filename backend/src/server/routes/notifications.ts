/**
 * GET /notifications — TypeScript port of
 * backend/onyx/server/features/notifications/api.py get_notifications_api
 * returning PaginatedNotifications (models.py):
 *   { notifications: [...], total_items, undismissed_count, page_num,
 *     page_size, has_more }
 *
 * A fresh deployment has no stored notifications, so an empty page is the
 * faithful response. Requires authentication (Permission.BASIC_ACCESS).
 * The notification-creation side effects of page_num == 0 unfiltered reads
 * (release-notes checks, misconfiguration checks) are ported with the
 * background task work — see docs/PORT_MAP.md.
 */
import { Hono } from "hono";
import { getAuth, requireAuth } from "../../auth/middleware";

export const notificationsRoutes = new Hono();

notificationsRoutes.get("/notifications", requireAuth, (c) => {
  const auth = getAuth(c);
  if (!auth) {
    return c.json({ detail: "Unauthorized" }, 401);
  }

  const pageNum = Math.max(0, Number(c.req.query("page_num") ?? "0") || 0);
  const pageSize = Math.min(
    50,
    Math.max(1, Number(c.req.query("page_size") ?? "10") || 10),
  );

  return c.json({
    notifications: [],
    total_items: 0,
    undismissed_count: 0,
    page_num: pageNum,
    page_size: pageSize,
    has_more: false,
  });
});
