import { z } from "zod";
import { createGhlClient, GhlConfig, mapGhlError } from "./client.js";
import { Contact } from "../shared/types.js";

const ContactSchema = z.object({
  id: z.string(),
  firstName: z.string().optional().nullable(),
  lastName: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  dateAdded: z.string().optional().nullable(),
});

const SearchResponseSchema = z.object({
  contacts: z.array(ContactSchema).optional(),
  data: z.array(ContactSchema).optional(),
  meta: z
    .object({
      searchAfter: z.string().optional().nullable(),
    })
    .optional(),
});

const ContactDetailsSchema = z
  .object({
    id: z.string(),
    firstName: z.string().optional().nullable(),
    lastName: z.string().optional().nullable(),
    email: z.string().optional().nullable(),
    phone: z.string().optional().nullable(),
    source: z.string().optional().nullable(),
    dateAdded: z.string().optional().nullable(),
    dateUpdated: z.string().optional().nullable(),
    tags: z.array(z.string()).optional().nullable(),
    attributionSource: z.any().optional(),
    lastAttributionSource: z.any().optional(),
    city: z.string().optional().nullable(),
    state: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    postalCode: z.string().optional().nullable(),
    timezone: z.string().optional().nullable(),
    dnd: z.boolean().optional().nullable(),
  })
  .passthrough();

export const searchContacts = async (
  config: GhlConfig,
  query: string,
  searchAfter?: string
) => {
  try {
    const client = createGhlClient(config);
    const response = await client.post("/contacts/search", {
      locationId: config.locationId,
      query,
      pageLimit: 20,
      ...(searchAfter ? { searchAfter } : {}),
    });

    const parsed = SearchResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error("Unexpected contacts response format");
    }

    const contacts = (parsed.data.contacts ?? parsed.data.data ?? []).map(
      (contact): Contact => ({
        id: contact.id,
        firstName: contact.firstName ?? undefined,
        lastName: contact.lastName ?? undefined,
        email: contact.email ?? undefined,
        phone: contact.phone ?? undefined,
        dateAdded: contact.dateAdded ?? undefined,
      })
    );

    return {
      contacts,
      searchAfter: parsed.data.meta?.searchAfter ?? undefined,
    };
  } catch (error) {
    throw mapGhlError(error);
  }
};

export type ContactDetails = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  source?: string;
  dateAdded?: string;
  dateUpdated?: string;
  tags?: string[];
  attributionSource?: unknown;
  lastAttributionSource?: unknown;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
  timezone?: string;
  dnd?: boolean;
  raw?: Record<string, unknown>;
};

export const getContactById = async (
  config: GhlConfig,
  contactId: string
): Promise<ContactDetails> => {
  try {
    const client = createGhlClient(config);
    const response = await client.get(`/contacts/${contactId}`);
    const payload = response.data?.contact ?? response.data;
    const parsed = ContactDetailsSchema.safeParse(payload);
    const data = parsed.success ? parsed.data : payload;
    const raw =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : undefined;

    return {
      id: data.id,
      firstName: data.firstName ?? undefined,
      lastName: data.lastName ?? undefined,
      email: data.email ?? undefined,
      phone: data.phone ?? undefined,
      source: data.source ?? undefined,
      dateAdded: data.dateAdded ?? undefined,
      dateUpdated: data.dateUpdated ?? undefined,
      tags: data.tags ?? undefined,
      attributionSource: data.attributionSource ?? undefined,
      lastAttributionSource: data.lastAttributionSource ?? undefined,
      city: data.city ?? undefined,
      state: data.state ?? undefined,
      country: data.country ?? undefined,
      postalCode: data.postalCode ?? undefined,
      timezone: data.timezone ?? undefined,
      dnd: data.dnd ?? undefined,
      raw,
    };
  } catch (error) {
    throw mapGhlError(error);
  }
};
