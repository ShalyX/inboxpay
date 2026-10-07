export function normalizeBusinessName(value) {
  const raw = String(value ?? "");
  if ([...raw].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error("Business name contains unsupported control characters");
  }
  const name = raw.replace(/\s+/g, " ").trim();
  if (name.length < 2) throw new Error("Business name must be at least 2 characters");
  if (name.length > 80) throw new Error("Business name must be 80 characters or fewer");
  return name;
}
