import type { Role } from "@/lib/auth";

export const PUSH_EVENT_TYPES = [
  "post_stock_issued",
  "post_stock_returned",
  "defect_act_created",
  "work_act_created",
  "work_awaiting_warehouse",
  "storekeeper_post_issue_completed",
  "storekeeper_warehouse_return_accepted",
] as const;

export type PushEventType = typeof PUSH_EVENT_TYPES[number];

type Audience = "post-members" | "management" | "management-and-storekeepers";

type PushEventDefinition = {
  actorRoles: Role[];
  audience: Audience;
  title: string;
};

type PushRecipient = {
  userId?: string;
  deviceId?: string;
};

export const PUSH_RECIPIENT_PAGE_SIZE = 500;
export const PUSH_RECIPIENT_MAX_PAGES = 100;

const definitions: Record<PushEventType, PushEventDefinition> = {
  post_stock_issued: {
    actorRoles: ["owner", "admin", "storekeeper"],
    audience: "post-members",
    title: "Товар выдан на ваш пост",
  },
  post_stock_returned: {
    actorRoles: ["owner", "admin", "storekeeper"],
    audience: "management-and-storekeepers",
    title: "Товар возвращён на склад",
  },
  defect_act_created: {
    actorRoles: ["owner", "admin", "storekeeper", "worker"],
    audience: "management-and-storekeepers",
    title: "Создан акт дефектовки",
  },
  work_act_created: {
    actorRoles: ["owner", "admin", "storekeeper", "worker"],
    audience: "management-and-storekeepers",
    title: "Создан акт выполненных работ",
  },
  work_awaiting_warehouse: {
    actorRoles: ["owner", "admin"],
    audience: "management-and-storekeepers",
    title: "АВР ожидает приёмки на склад",
  },
  storekeeper_post_issue_completed: {
    actorRoles: ["storekeeper"],
    audience: "management",
    title: "Кладовщик выдал товар на пост",
  },
  storekeeper_warehouse_return_accepted: {
    actorRoles: ["storekeeper"],
    audience: "management-and-storekeepers",
    title: "Товар принят на склад после АВР",
  },
};

export function isPushEventType(value: string): value is PushEventType {
  return PUSH_EVENT_TYPES.includes(value as PushEventType);
}

export function pushActorAllowed(type: PushEventType, role: Role) {
  return definitions[type].actorRoles.includes(role);
}

export function pushPresentation(
  type: PushEventType,
  post: string,
  entityNo: string,
  summary: string,
) {
  const suffix = [entityNo, post && `пост ${post}`].filter(Boolean).join(" · ");
  return {
    title: definitions[type].title,
    body: summary || suffix,
  };
}

export function normalizePostAssignment(value: string) {
  // Keep this explicit whitespace set in sync with the SQLite migration and
  // triggers. It covers every whitespace character accepted by our forms and
  // avoids relying on SQLite trim()/lower() Unicode behavior.
  return value
    .replace(/[\t\n\v\f\r \u00a0]+/g, " ")
    .trim()
    .toLocaleLowerCase("ru-RU");
}

export function pushRecipientQuery(
  type: PushEventType,
  post = "",
  actorUserId = "",
) {
  const audience = definitions[type].audience;
  const select = `SELECT push_devices.user_id AS userId,
                         push_devices.device_id AS deviceId,
                         push_devices.token,
                         users.assignment
                  FROM push_devices
                  JOIN users ON users.id = push_devices.user_id`;
  if (audience === "post-members") {
    return {
      sql: `${select}
            WHERE users.status = 'active'
              AND users.assignment_key = ?
              AND push_devices.user_id <> ?
            ORDER BY push_devices.device_id
            LIMIT ? OFFSET ?`,
      bindings: [normalizePostAssignment(post), actorUserId],
    };
  }
  const roles = audience === "management"
    ? "'owner', 'admin'"
    : "'owner', 'admin', 'storekeeper'";
  return {
    sql: `${select}
          WHERE users.status = 'active'
            AND users.role IN (${roles})
            AND push_devices.user_id <> ?
          ORDER BY push_devices.device_id
          LIMIT ? OFFSET ?`,
    bindings: [actorUserId],
  };
}

/**
 * Recipient queries filter by the normalized assignment key in SQL. Pagination
 * remains a safety net for posts or management groups with many devices.
 */
export async function collectPushRecipients<T extends PushRecipient>(
  fetchPage: (limit: number, offset: number) => Promise<T[]> | T[],
  pageSize = PUSH_RECIPIENT_PAGE_SIZE,
) {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error("Invalid push recipient page size");
  }
  const recipients: T[] = [];
  for (let pageIndex = 0; pageIndex < PUSH_RECIPIENT_MAX_PAGES; pageIndex += 1) {
    const offset = pageIndex * pageSize;
    const page = await fetchPage(pageSize, offset);
    if (page.length > pageSize) {
      throw new Error("Push recipient page exceeded the requested limit");
    }
    recipients.push(...page);
    if (page.length < pageSize) break;
    if (pageIndex === PUSH_RECIPIENT_MAX_PAGES - 1) {
      throw new Error("Push recipient pagination limit exceeded");
    }
  }
  return recipients;
}

export function excludePreviouslyNotifiedDevices<T extends PushRecipient>(
  recipients: T[],
  priorDeviceIds: Iterable<string>,
) {
  const excluded = new Set(priorDeviceIds);
  return recipients.filter((recipient) => !excluded.has(String(recipient.deviceId ?? "")));
}
