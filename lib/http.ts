export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
}

const OVERSIZE_DRAIN_LIMIT_BYTES = 4_000_000;
const OVERSIZE_DRAIN_TIMEOUT_MS = 2_000;

async function drainReaderBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  byteLimit = OVERSIZE_DRAIN_LIMIT_BYTES,
  timeoutMs = OVERSIZE_DRAIN_TIMEOUT_MS,
) {
  let drained = 0;
  const deadline = Date.now() + timeoutMs;
  while (drained <= byteLimit) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      reader.read().then((result) => ({ kind: "read" as const, result })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome.kind === "timeout") break;
    if (outcome.result.done) return true;
    drained += outcome.result.value.byteLength;
  }
  await reader.cancel("request body drain budget exceeded").catch(() => undefined);
  return false;
}

export async function readJsonObject(
  request: Request,
  maxBytes?: number,
): Promise<Record<string, unknown> | null> {
  const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    return null;
  }
  try {
    let value: unknown;
    if (maxBytes == null) {
      value = await request.json();
    } else {
      const reader = request.body?.getReader();
      if (!reader) return null;
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        // Reject a declared oversized body before reading it. Cloudflare's
        // request proxy owns the transport and can discard the body without
        // making this Worker spend CPU/time draining several megabytes.
        throw new RequestBodyTooLargeError();
      }
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let received = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        received += result.value.byteLength;
        if (received > maxBytes) {
          // Unknown/chunked lengths are discovered only after the limit. Drain
          // the bounded tail for connection reuse, then reject the body.
          await drainReaderBounded(reader);
          throw new RequestBodyTooLargeError();
        }
        chunks.push(decoder.decode(result.value, { stream: true }));
      }
      chunks.push(decoder.decode());
      value = JSON.parse(chunks.join(""));
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    return null;
  }
}
