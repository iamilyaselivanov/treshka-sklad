import { env } from "cloudflare:workers";

type FirebaseConfig = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

export type PushMessage = {
  title: string;
  body: string;
  eventId: string;
  eventType: string;
  post: string;
  entityNo: string;
};

export type PushSendResult =
  | { status: "sent"; providerMessageId: string }
  | { status: "disabled"; error: string }
  | { status: "failed"; error: string; unregisterToken: boolean };

let cachedAccessToken: { value: string; expiresAt: number } | null = null;

function firebaseConfig(): FirebaseConfig | null {
  const bindings = env as unknown as Record<string, unknown>;
  const projectId = String(bindings.FIREBASE_PROJECT_ID ?? "").trim();
  const clientEmail = String(bindings.FIREBASE_CLIENT_EMAIL ?? "").trim();
  const privateKey = String(bindings.FIREBASE_PRIVATE_KEY ?? "").replaceAll("\\n", "\n").trim();
  return projectId && clientEmail && privateKey
    ? { projectId, clientEmail, privateKey }
    : null;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function encodeJson(value: unknown) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemBytes(pem: string) {
  const encoded = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!encoded) throw new Error("Пустой закрытый ключ Firebase");
  const decoded = atob(encoded);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

async function serviceAccountJwt(config: FirebaseConfig) {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const claims = encodeJson({
    iss: config.clientEmail,
    sub: config.clientEmail,
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    iat: now,
    exp: now + 3_600,
  });
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemBytes(config.privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function firebaseAccessToken(config: FirebaseConfig) {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 60_000) {
    return cachedAccessToken.value;
  }
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await serviceAccountJwt(config),
    }),
  });
  const data = await response.json() as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || `Firebase OAuth: HTTP ${response.status}`);
  }
  cachedAccessToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in || 3_600)) * 1_000,
  };
  return data.access_token;
}

function firebaseErrorText(value: unknown) {
  if (!value || typeof value !== "object") return "Неизвестная ошибка Firebase";
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object") return "Неизвестная ошибка Firebase";
  const record = error as { message?: unknown; status?: unknown; details?: unknown };
  return [record.status, record.message, JSON.stringify(record.details ?? "")]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(": ")
    .slice(0, 1_000);
}

export function isFirebasePushConfigured() {
  return firebaseConfig() !== null;
}

export async function sendDevicePush(token: string, message: PushMessage): Promise<PushSendResult> {
  const config = firebaseConfig();
  if (!config) {
    return { status: "disabled", error: "Firebase-секреты сервера не настроены" };
  }
  try {
    const accessToken = await firebaseAccessToken(config);
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data: {
              title: message.title,
              body: message.body,
              eventId: message.eventId,
              eventType: message.eventType,
              post: message.post,
              entityNo: message.entityNo,
            },
            android: {
              priority: "HIGH",
              notification: {
                channel_id: "treshka_sklad_events",
                sound: "default",
              },
            },
          },
        }),
      },
    );
    const data = await response.json() as { name?: string } | unknown;
    if (response.ok && typeof data === "object" && data && "name" in data) {
      return { status: "sent", providerMessageId: String(data.name ?? "") };
    }
    const error = firebaseErrorText(data);
    const unregisterToken = response.status === 404
      || error.includes("UNREGISTERED")
      || error.includes("registration token is not a valid FCM");
    return { status: "failed", error, unregisterToken };
  } catch (cause) {
    return {
      status: "failed",
      error: (cause instanceof Error ? cause.message : "Ошибка отправки Firebase").slice(0, 1_000),
      unregisterToken: false,
    };
  }
}
