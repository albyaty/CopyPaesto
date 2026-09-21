export type IncomingChunkDisposition = "append" | "duplicate" | "invalid";

export function classifyIncomingChunk(
  nextOffset: number,
  writtenOffset: number,
  offset: number,
  byteLength: number,
): IncomingChunkDisposition {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(byteLength) ||
    offset < 0 ||
    byteLength <= 0
  ) return "invalid";
  if (offset === nextOffset) return "append";
  if (offset < nextOffset && offset + byteLength <= writtenOffset) return "duplicate";
  return "invalid";
}

export function isValidResumePosition(
  acknowledged: number,
  sent: number,
  size: number,
  received: number,
) {
  return Number.isSafeInteger(received)
    && received >= acknowledged
    && received <= sent
    && received <= size;
}

export function combineTransferChunks(chunks: ArrayBuffer[], byteLength: number) {
  if (chunks.length === 1) return chunks[0];
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}
