import { GhlConfig } from "./client.js";

export type AccountEntry = { id: string; name: string; token: string };

const toTitle = (value: string) =>
  value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

export const getAccountEntries = (): AccountEntry[] => {
  const entries: AccountEntry[] = [];

  Object.keys(process.env).forEach((key) => {
    if (!key.startsWith("GHL_") || !key.endsWith("_PRIVATE_TOKEN")) return;
    const base = key.replace(/^GHL_/, "").replace(/_PRIVATE_TOKEN$/, "");
    const token = process.env[key] ?? "";
    const locationId = process.env[`GHL_${base}_LOCATION_ID`] ?? "";
    if (!token || !locationId) return;
    entries.push({ name: toTitle(base), id: locationId, token });
  });

  if (entries.length > 0) return entries;

  const raw = process.env.GHL_LOCATIONS_JSON;
  const sharedToken = process.env.GHL_PRIVATE_TOKEN;
  if (raw && sharedToken) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      return Object.entries(parsed)
        .filter(([, id]) => typeof id === "string" && id.length > 0)
        .map(([name, id]) => ({ name, id, token: sharedToken }));
    } catch {
      return [];
    }
  }

  const fallbackId = process.env.GHL_LOCATION_ID;
  if (fallbackId && sharedToken) {
    return [{ name: "Default", id: fallbackId, token: sharedToken }];
  }

  return [];
};

export const resolveAccount = (requested?: string) => {
  const accounts = getAccountEntries();
  if (!requested) return accounts[0];
  return accounts.find(
    (account) =>
      account.id === requested || account.name.toLowerCase() === requested.toLowerCase()
  );
};

export const getGhlConfigForAccount = (locationId?: string): GhlConfig => {
  const version = process.env.GHL_API_VERSION || "2021-07-28";
  const resolved = resolveAccount(locationId);

  if (!resolved?.token || !resolved?.id) {
    throw new Error("GHL credentials not configured for this subaccount");
  }

  return { token: resolved.token, locationId: resolved.id, version };
};
