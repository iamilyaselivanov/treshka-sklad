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
  assignment?: string;
};

export const PUSH_RECIPIENT_PAGE_SIZE = 500;

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
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

export function pushRecipientQuery(type: PushEventType) {
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
              AND TRIM(users.assignment) <> ''
            ORDER BY push_devices.device_id
            LIMIT ? OFFSET ?`,
      filterPost: true,
    };
  }
  const roles = audience === "management"
    ? "'owner', 'admin'"
    : "'owner', 'admin', 'storekeeper'";
  return {
    sql: `${select}
          WHERE users.status = 'active' AND users.role IN (${roles})
          ORDER BY push_devices.device_id
          LIMIT ? OFFSET ?`,
    filterPost: false,
  };
}

/**
 * D1/SQLite cannot lowercase Cyrillic reliably, so post assignment is still
 * normalized in application code. Pagination guarantees that the SQL LIMIT
 * never silently drops matching recipients that happen to be on a later page.
 */
export async function collectPushRecipients<T extends PushRecipient>(
  fetchPage: (limit: number, offset: number) => Promise<T[]> | T[],
  filterPost: boolean,
  post: string,
  pageSize = PUSH_RECIPIENT_PAGE_SIZE,
) {
  const recipients: T[] = [];
  const normalizedPost = normalizePostAssignment(post);
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(pageSize, offset);
    recipients.push(...page.filter((device) =>
      !filterPost
      || normalizePostAssignment(String(device.assignment ?? "")) === normalizedPost));
    if (page.length < pageSize) break;
  }
  return recipients;
}
