import axios, { AxiosError } from "axios";

export type GhlConfig = {
  token: string;
  locationId: string;
  version: string;
};

export const GHL_BASE_URL = "https://services.leadconnectorhq.com";

export const createGhlClient = (config: GhlConfig) => {
  return axios.create({
    baseURL: GHL_BASE_URL,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      Version: config.version,
    },
    timeout: 15000,
  });
};

export class GhlError extends Error {
  status?: number;
  userMessage: string;

  constructor(message: string, status?: number, userMessage?: string) {
    super(message);
    this.status = status;
    this.userMessage = userMessage ?? "Er ging iets mis bij GoHighLevel.";
  }
}

export const mapGhlError = (error: unknown) => {
  if (axios.isAxiosError(error)) {
    const err = error as AxiosError<any>;
    const status = err.response?.status;

    if (status === 401 || status === 403) {
      return new GhlError(
        "Unauthorized",
        status,
        "Geen toegang tot GHL. Controleer je token en rechten."
      );
    }

    if (status === 404) {
      const detail =
        typeof err.response?.data?.message === "string"
          ? ` (${err.response.data.message})`
          : "";
      return new GhlError(
        "Not Found",
        status,
        `GHL resource niet gevonden. Controleer IDs.${detail}`
      );
    }

    if (status === 429) {
      return new GhlError(
        "Rate Limited",
        status,
        "GHL rate limit bereikt. Wacht even en probeer opnieuw."
      );
    }

    return new GhlError(
      err.message,
      status,
      "Er ging iets mis bij GHL. Probeer opnieuw."
    );
  }

  if (error instanceof Error) {
    return new GhlError(error.message);
  }

  return new GhlError("Unknown error");
};
