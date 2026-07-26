export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large");
    this.name = "RequestBodyTooLargeError";
  }
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
      const declaredLength = Number(request.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new RequestBodyTooLargeError();
      }
      const reader = request.body?.getReader();
      if (!reader) return null;
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let received = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        received += result.value.byteLength;
        if (received > maxBytes) {
          await reader.cancel("request body exceeds size limit").catch(() => undefined);
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
