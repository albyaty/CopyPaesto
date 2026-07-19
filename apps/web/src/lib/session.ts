const SESSION_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const SESSION_LENGTH = 12;

function randomInt(max: number) {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value);
  while (value[0] >= limit);
  return value[0] % max;
}

export function generateSessionCode() {
  let code = "";
  for (let index = 0; index < SESSION_LENGTH; index += 1) {
    code += SESSION_ALPHABET[randomInt(SESSION_ALPHABET.length)];
  }
  return formatSessionCode(code);
}

export function generatePin() {
  return String(10_000 + randomInt(90_000));
}

export function normalizeSessionCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function formatSessionCode(value: string) {
  const normalized = normalizeSessionCode(value).slice(0, SESSION_LENGTH);
  return normalized.match(/.{1,4}/g)?.join("-") ?? normalized;
}

export function isValidSessionCode(value: string) {
  const normalized = normalizeSessionCode(value);
  return (
    normalized.length === SESSION_LENGTH &&
    [...normalized].every((character) => SESSION_ALPHABET.includes(character))
  );
}

export function normalizePin(value: string) {
  return value.replace(/\D/g, "").slice(0, 5);
}

export function isValidPin(value: string) {
  return /^\d{5}$/.test(value);
}

export function normalizePairingCode(value: string) {
  return value.replace(/\D/g, "").slice(0, 5);
}

export function isValidPairingCode(value: string) {
  return /^\d{5}$/.test(value);
}

export function readSessionFromHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const value = params.get("session") ?? "";
  return isValidSessionCode(value) ? formatSessionCode(value) : "";
}

export function writeSessionToHash(sessionCode: string) {
  const params = new URLSearchParams();
  params.set("session", normalizeSessionCode(sessionCode));
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${params}`);
}

export function clearSessionHash() {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}
