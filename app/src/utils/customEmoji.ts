type CustomEmoji = { code: string; blobId: string; mimeType: string; roomId: string | null };

function normalizeCode(code: string): string {
  let out = code.trim();
  if (!out.startsWith(':')) out = `:${out}`;
  if (!out.endsWith(':')) out = `${out}:`;
  return out;
}

export function parseCustomEmoji(raw: unknown): CustomEmoji[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((e): e is CustomEmoji => !!e && typeof e === 'object')
      .map((e: any) => ({
        code: normalizeCode(String(e.code || '')),
        blobId: String(e.blobId || ''),
        mimeType: String(e.mimeType || 'image/png'),
        roomId: e.roomId ?? null,
      }))
      .filter(e => e.code.length > 2 && e.blobId.length > 0);
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parseCustomEmoji(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizeCustomEmojiList(list: CustomEmoji[]): CustomEmoji[] {
  return list.map(e => ({ ...e, code: normalizeCode(e.code) }));
}
