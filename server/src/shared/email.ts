export const extractEmail = (value?: string | null) => {
  if (!value) return null;
  const match = value.match(/<([^>]+)>/);
  const email = (match ? match[1] : value).trim();
  return email ? email.toLowerCase() : null;
};

export const cleanEmailReply = (value?: string | null) => {
  if (!value) return "";
  let text = value.replace(/\r\n/g, "\n").trim();
  const splitPatterns = [
    /\nOn .+ wrote:\n/i,
    /\n-----Original Message-----\n/i,
    /\nFrom:\s.+\nSent:\s.+\nTo:\s.+\nSubject:\s.+\n/i,
    /\n_{2,}\n/,
  ];
  for (const pattern of splitPatterns) {
    const parts = text.split(pattern);
    if (parts.length > 1) {
      text = parts[0].trim();
    }
  }
  const lines = text
    .split("\n")
    .filter((line) => !line.trim().startsWith(">"))
    .map((line) => line.replace(/^\s*On .* wrote:\s*$/i, ""))
    .filter((line) => line.trim().length > 0);
  return lines.join("\n").trim();
};

