export const normalizePhoneDigits = (value?: string | null): string | undefined => {
  if (typeof value !== "string") return undefined;
  const digits = value.replace(/\D/g, "");
  return digits.length > 0 ? digits : undefined;
};

export const phoneLast10 = (normalizedPhone?: string): string | undefined => {
  if (!normalizedPhone) return undefined;
  return normalizedPhone.length <= 10
    ? normalizedPhone
    : normalizedPhone.slice(normalizedPhone.length - 10);
};

export const phonesLikelyMatch = (
  a?: string | null,
  b?: string | null
): boolean => {
  const aNorm = normalizePhoneDigits(a);
  const bNorm = normalizePhoneDigits(b);
  if (!aNorm || !bNorm) return false;
  if (aNorm === bNorm) return true;
  const aLast10 = phoneLast10(aNorm);
  const bLast10 = phoneLast10(bNorm);
  if (!aLast10 || !bLast10) return false;
  return aLast10 === bLast10;
};
