import { z } from "zod";
import { createGhlClient, GhlConfig, mapGhlError } from "./client.js";

const OpportunitySchema = z
  .object({
    id: z.string(),
    contactId: z.string().optional().nullable(),
    pipelineId: z.string().optional().nullable(),
    pipelineStageId: z.string().optional().nullable(),
    pipelineStageName: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    createdAt: z.string().optional().nullable(),
    updatedAt: z.string().optional().nullable(),
  })
  .passthrough();

const OpportunitySearchSchema = z.object({
  opportunities: z.array(OpportunitySchema).optional(),
  data: z.array(OpportunitySchema).optional(),
  items: z.array(OpportunitySchema).optional(),
  total: z.number().optional(),
  meta: z
    .object({
      searchAfter: z.string().optional().nullable(),
      nextPage: z.string().optional().nullable(),
    })
    .optional(),
});

const PipelineStageSchema = z.object({
  id: z.string(),
  name: z.string().optional().nullable(),
});

const PipelineSchema = z.object({
  id: z.string(),
  name: z.string().optional().nullable(),
  stages: z.array(PipelineStageSchema).optional(),
});

const PipelinesResponseSchema = z.object({
  pipelines: z.array(PipelineSchema).optional(),
  data: z.array(PipelineSchema).optional(),
  items: z.array(PipelineSchema).optional(),
});

export type OpportunityStage = {
  pipelineStageId?: string;
  pipelineStageName?: string;
};

export type OpportunityItem = {
  id: string;
  name?: string;
  status?: string;
  contactId?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  pipelineStageName?: string;
  createdAt?: string;
  updatedAt?: string;
};

const normalizeStageName = (value?: string | null) =>
  (value ?? "").trim().toLowerCase();

export const listOpportunities = async (
  config: GhlConfig,
  options?: { limit?: number; page?: number; searchAfter?: string; query?: string }
) => {
  try {
    const client = createGhlClient(config);
    const limit = options?.limit ?? 50;
    const parsedPage =
      options?.page ??
      (() => {
        if (!options?.searchAfter) return undefined;
        const numeric = Number(options.searchAfter);
        return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : undefined;
      })();
    const page = parsedPage ?? 1;

    const response = await client.post("/opportunities/search", {
      locationId: config.locationId,
      limit,
      ...(page > 1 ? { page } : {}),
      ...(options?.searchAfter && !parsedPage
        ? { searchAfter: options.searchAfter }
        : {}),
      ...(options?.query ? { query: options.query } : {}),
    });

    const parsed = OpportunitySearchSchema.safeParse(response.data);
    if (!parsed.success) {
      throw new Error("Unexpected opportunities response format");
    }

    const opportunities =
      parsed.data.opportunities ?? parsed.data.data ?? parsed.data.items ?? [];

    const mapped: OpportunityItem[] = opportunities.map((item) => ({
      id: item.id,
      name: item.name ?? undefined,
      status: item.status ?? undefined,
      contactId: item.contactId ?? undefined,
      pipelineId: item.pipelineId ?? undefined,
      pipelineStageId: item.pipelineStageId ?? undefined,
      pipelineStageName: item.pipelineStageName ?? undefined,
      createdAt: item.createdAt ?? undefined,
      updatedAt: item.updatedAt ?? undefined,
    }));

    const total =
      typeof parsed.data.total === "number" ? parsed.data.total : undefined;

    const cursorToken =
      parsed.data.meta?.searchAfter ?? parsed.data.meta?.nextPage ?? undefined;

    const derivedNextPage =
      typeof total === "number" && page * limit < total ? String(page + 1) : undefined;

    const searchAfter = cursorToken ?? derivedNextPage;

    return { opportunities: mapped, searchAfter, total };
  } catch (error) {
    throw mapGhlError(error);
  }
};

export const listPipelines = async (config: GhlConfig) => {
  try {
    const client = createGhlClient(config);
    const response = await client.get("/opportunities/pipelines", {
      params: { locationId: config.locationId },
    });
    const parsed = PipelinesResponseSchema.safeParse(response.data);
    if (!parsed.success) {
      return [];
    }
    return parsed.data.pipelines ?? parsed.data.data ?? parsed.data.items ?? [];
  } catch (error) {
    throw mapGhlError(error);
  }
};

export const getPipelineStageMap = async (config: GhlConfig) => {
  const pipelines = await listPipelines(config);
  const map = new Map<string, string>();
  pipelines.forEach((pipeline) => {
    pipeline.stages?.forEach((stage) => {
      if (stage.id) {
        map.set(stage.id, stage.name ?? stage.id);
      }
    });
  });
  return map;
};

export const getLatestOpportunityStage = async (
  config: GhlConfig,
  contactId: string
): Promise<OpportunityStage | null> => {
  try {
    const client = createGhlClient(config);
    const response = await client.post("/opportunities/search", {
      locationId: config.locationId,
      contactId,
      limit: 1,
    });
    const parsed = OpportunitySearchSchema.safeParse(response.data);
    if (!parsed.success) {
      return null;
    }
    const opportunities =
      parsed.data.opportunities ?? parsed.data.data ?? parsed.data.items ?? [];
    const first = opportunities[0];
    if (!first) return null;
    return {
      pipelineStageId: first.pipelineStageId ?? undefined,
      pipelineStageName: first.pipelineStageName ?? undefined,
    };
  } catch (error) {
    throw mapGhlError(error);
  }
};

export const getLatestOpportunityForContact = async (
  config: GhlConfig,
  contactId: string
): Promise<OpportunityItem | null> => {
  try {
    const client = createGhlClient(config);
    const response = await client.post("/opportunities/search", {
      locationId: config.locationId,
      contactId,
      limit: 1,
    });
    const parsed = OpportunitySearchSchema.safeParse(response.data);
    if (!parsed.success) return null;
    const opportunities =
      parsed.data.opportunities ?? parsed.data.data ?? parsed.data.items ?? [];
    const first = opportunities[0];
    if (!first) return null;
    return {
      id: first.id,
      name: first.name ?? undefined,
      status: first.status ?? undefined,
      contactId: first.contactId ?? undefined,
      pipelineId: first.pipelineId ?? undefined,
      pipelineStageId: first.pipelineStageId ?? undefined,
      pipelineStageName: first.pipelineStageName ?? undefined,
      createdAt: first.createdAt ?? undefined,
      updatedAt: first.updatedAt ?? undefined,
    };
  } catch (error) {
    throw mapGhlError(error);
  }
};

export const findPipelineStageByName = async (
  config: GhlConfig,
  stageName: string
): Promise<{ id: string; name: string } | null> => {
  const target = normalizeStageName(stageName);
  if (!target) return null;
  const pipelines = await listPipelines(config);

  let fuzzyMatch: { id: string; name: string } | null = null;
  for (const pipeline of pipelines) {
    for (const stage of pipeline.stages ?? []) {
      if (!stage.id) continue;
      const currentName = (stage.name ?? stage.id).trim();
      const normalized = normalizeStageName(currentName);
      if (!normalized) continue;
      if (normalized === target) {
        return { id: stage.id, name: currentName };
      }
      if (!fuzzyMatch && (normalized.includes(target) || target.includes(normalized))) {
        fuzzyMatch = { id: stage.id, name: currentName };
      }
    }
  }
  return fuzzyMatch;
};

export const updateOpportunityStage = async (input: {
  config: GhlConfig;
  opportunityId: string;
  pipelineStageId: string;
  pipelineId?: string;
}) => {
  try {
    const client = createGhlClient(input.config);
    const payload = {
      locationId: input.config.locationId,
      pipelineStageId: input.pipelineStageId,
      ...(input.pipelineId ? { pipelineId: input.pipelineId } : {}),
    };
    const attempts = [
      () => client.put(`/opportunities/${input.opportunityId}`, payload),
      () =>
        client.put(`/opportunities/${input.opportunityId}`, {
          id: input.opportunityId,
          ...payload,
        }),
      () => client.post(`/opportunities/${input.opportunityId}`, payload),
    ];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        await attempt();
        return { success: true as const };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("Opportunity stage update failed.");
  } catch (error) {
    throw mapGhlError(error);
  }
};

export const updateLatestOpportunityStageByName = async (input: {
  config: GhlConfig;
  contactId: string;
  stageName: string;
}) => {
  const target = input.stageName.trim();
  if (!target) {
    return { updated: false as const, reason: "empty_target_stage" as const };
  }

  const opportunity = await getLatestOpportunityForContact(input.config, input.contactId);
  if (!opportunity?.id) {
    return { updated: false as const, reason: "no_opportunity_for_contact" as const };
  }
  if (normalizeStageName(opportunity.pipelineStageName) === normalizeStageName(target)) {
    return {
      updated: false as const,
      reason: "already_in_target_stage" as const,
      opportunityId: opportunity.id,
    };
  }

  const stage = await findPipelineStageByName(input.config, target);
  if (!stage?.id) {
    return { updated: false as const, reason: "stage_not_found" as const };
  }

  await updateOpportunityStage({
    config: input.config,
    opportunityId: opportunity.id,
    pipelineId: opportunity.pipelineId,
    pipelineStageId: stage.id,
  });

  return {
    updated: true as const,
    opportunityId: opportunity.id,
    stageId: stage.id,
    stageName: stage.name,
  };
};
