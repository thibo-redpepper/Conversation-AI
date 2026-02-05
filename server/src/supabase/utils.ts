import crypto from "crypto";

const SALT = process.env.HASH_SALT || "ghl-sync";

export const hashValue = (value: string) =>
  crypto.createHash("sha256").update(`${SALT}:${value}`).digest("hex");

export const redactText = (value?: string | null) => {
  if (!value) return "";
  let result = value;
  result = result.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[EMAIL]"
  );
  result = result.replace(/(\+?\d[\d\s().-]{7,}\d)/g, "[PHONE]");
  return result;
};
