export function normalizeSpanishTaxId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .toUpperCase()
    .replace(/^ES/, '')
    .replace(/[\s\-\/\.]/g, '');
  return cleaned || null;
}
