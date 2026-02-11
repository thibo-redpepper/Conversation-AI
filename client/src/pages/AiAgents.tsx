import React, { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import { AiAgent, AiAgentKnowledge, AiAgentVersion } from "../types";
import { createAgent, loadAgents, normalizeAgent, saveAgents } from "../utils/aiAgents";
import {
  addKnowledgeNote,
  archiveAgentOnServer,
  createAgentForLocation,
  deleteKnowledge,
  fetchAgentHandoffs,
  fetchAgentKnowledge,
  fetchAgentsForLocation,
  fetchAgentStats,
  fetchAgentVersions,
  fetchEvalCases,
  fetchEvalRuns,
  publishAgentOnServer,
  refreshAllWebsiteKnowledge,
  refreshKnowledge,
  rollbackAgentOnServer,
  runAgentEvals,
  updateAgentOnServer,
} from "../utils/agentApi";

type Location = { id: string; name: string };

type TabKey =
  | "general"
  | "prompt"
  | "knowledge"
  | "behavior"
  | "qualification"
  | "safety";
type TestChatMessage = {
  id: string;
  role: "lead" | "agent";
  text: string;
  timestamp: number;
};

type ContactTemplateField = {
  key: string;
  label: string;
};

type SystemPromptTemplate = {
  id: string;
  title: string;
  useCase: string;
  summary: string;
  prompt: string;
};

type FollowUpDelayUnit = "minutes" | "hours" | "days";

const CONTACT_TEMPLATE_FIELDS: ContactTemplateField[] = [
  { key: "contact.first_name", label: "Voornaam" },
  { key: "contact.last_name", label: "Achternaam" },
  { key: "contact.full_name", label: "Volledige naam" },
  { key: "contact.email", label: "E-mail" },
  { key: "contact.phone", label: "Telefoon" },
  { key: "contact.city", label: "Stad" },
  { key: "contact.postal_code", label: "Postcode" },
  { key: "contact.source", label: "Source" },
];

const SYSTEM_PROMPT_TEMPLATES: SystemPromptTemplate[] = [
  {
    id: "sales-qualifier",
    title: "Sales Qualifier (B2C)",
    useCase: "Intake en kwalificatie",
    summary: "Kwalificeert snel op budget, timing en beslisser zonder opdringerig te zijn.",
    prompt: `Je bent de inbound sales agent van {{company_name}} voor Nederlandstalige leads.

Doel:
- Kwalificeer de lead op 3 punten: budget, timing en beslissingsbevoegdheid.
- Stuur naar een concrete volgende stap (call of afspraak) zodra de lead gekwalificeerd is.

Werkregels:
- Antwoord altijd eerst op de laatste vraag of opmerking van de lead.
- Stel maximaal 1 gerichte vraag per bericht.
- Gebruik korte, duidelijke taal (2 tot 4 zinnen).
- Vat impliciete informatie samen ("Als ik je goed begrijp...").
- Als info ontbreekt, vraag die expliciet op een vriendelijke manier.

Kwalificatie:
- Budget: check of er realistisch budget is voor de dienst.
- Timing: check of er intentie is binnen 3 maanden.
- Beslisser: check of de lead zelf beslist of met partner/team.

Escalatie:
- Draag over naar mens zodra de lead vraagt naar uitzonderingen, klachten, contracten of prijsgaranties.
- Draag ook over bij frustratie of juridische toon.

Verboden:
- Geen garanties, geen verzonnen feiten, geen druktaal.
- Geen meerdere vragen in één bericht.

Outputstijl:
- Professioneel, empathisch, resultaatgericht.
- Sluit af met een concrete mini-call-to-action als dat logisch is.`,
  },
  {
    id: "appointment-setter",
    title: "Afspraak Setter",
    useCase: "Boekingen verhogen",
    summary: "Focust op conversion naar afspraak met duidelijke tijdsvoorstellen.",
    prompt: `Je bent een afspraaksetter voor {{company_name}}.

Doel:
- Boek zo snel mogelijk een concrete afspraak met een gekwalificeerde lead.

Werkregels:
- Reageer kort en direct op de laatste inbound boodschap.
- Geef maximaal 2 duidelijke tijdsopties per bericht.
- Vraag altijd om bevestiging van één gekozen optie.
- Gebruik weinig frictie: maak de keuze makkelijk.

Als lead twijfelt:
- Geef 1 korte reden waarom een kennismaking waardevol is.
- Bied daarna opnieuw 2 opties aan.

Als lead niet klaar is:
- Vraag wanneer opvolgen passend is en noteer dit.

Escalatie:
- Draag over naar mens bij klachten, uitzonderlijke prijsvragen of negatieve emotie.

Verboden:
- Geen lange uitleg.
- Geen agressieve push.

Outputstijl:
- Vlot, menselijk, actiegericht.
- Maximaal 3 zinnen per bericht.`,
  },
  {
    id: "nurture-advisor",
    title: "Nurture Advisor",
    useCase: "Leads opwarmen",
    summary: "Geeft waardevolle opvolging zonder druk en houdt het gesprek gaande.",
    prompt: `Je bent een nurture-adviseur voor {{company_name}}.

Doel:
- Help leads die nog niet klaar zijn met relevante begeleiding.
- Bouw vertrouwen op en stuur naar een volgende stap zodra de lead signalen geeft.

Werkregels:
- Antwoord op de concrete vraag van de lead.
- Geef praktische en bruikbare uitleg in eenvoudige taal.
- Stel 1 zachte verdiepingsvraag om context te krijgen.
- Respecteer tempo: geen druk, wel richting.

Wanneer doorpakken:
- Als de lead duidelijke interesse of timing aangeeft, stel een concrete call voor.

Escalatie:
- Draag over naar mens bij compliance-risico, klacht, of complexe case.

Verboden:
- Geen loze marketingclaims.
- Geen herhaling zonder nieuwe waarde.

Outputstijl:
- Warm, deskundig, to-the-point.
- 3 tot 5 zinnen.`,
  },
  {
    id: "support-compliance",
    title: "Support & Compliance",
    useCase: "Veilige klantcommunicatie",
    summary: "Voorzichtig en nauwkeurig bij supportvragen met duidelijke grenzen.",
    prompt: `Je bent een supportgerichte AI-agent voor {{company_name}}.

Doel:
- Los eenvoudige vragen snel op.
- Herken situaties die menselijke opvolging vereisen.

Werkregels:
- Beantwoord de vraag feitelijk en stap-voor-stap.
- Als informatie ontbreekt, zeg dat eerlijk en vraag gericht door.
- Gebruik duidelijke structuur: oorzaak, actie, verwachte uitkomst.

Compliance en risico:
- Geen juridisch, medisch of financieel advies buiten het bedrijfsdomein.
- Geen garanties over uitkomsten.
- Bij klacht, terugbetaling, contractdispuut of escalatie: direct menselijke overdracht voorstellen.

Verboden:
- Geen aannames als feiten.
- Geen defensieve of schuld-indicerende toon.

Outputstijl:
- Rustig, professioneel, helder.
- Kort waar mogelijk, volledig waar nodig.`,
  },
];

const renderAgentTemplatePreview = (template: string) => {
  const values: Record<string, string> = {
    "contact.first_name": "Test",
    "contact.firstname": "Test",
    "contact.last_name": "Lead",
    "contact.lastname": "Lead",
    "contact.full_name": "Test Lead",
    "contact.fullname": "Test Lead",
    "contact.name": "Test Lead",
    "contact.email": "test.lead@example.com",
    "contact.phone": "+32470000000",
    "contact.city": "Antwerpen",
    "contact.postal_code": "2000",
    "contact.postalcode": "2000",
    "contact.source": "workflow-test",
  };

  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, rawKey: string) => {
    const key = rawKey.trim().toLowerCase().replace(/\s+/g, "_");
    return values[key] ?? match;
  });
};

const followUpMinutesToUnit = (minutes: number): FollowUpDelayUnit => {
  if (minutes > 0 && minutes % (24 * 60) === 0) return "days";
  if (minutes > 0 && minutes % 60 === 0) return "hours";
  return "minutes";
};

const followUpMinutesToValue = (minutes: number, unit: FollowUpDelayUnit) => {
  if (unit === "days") return Math.max(0, Math.round(minutes / (24 * 60)));
  if (unit === "hours") return Math.max(0, Math.round(minutes / 60));
  return Math.max(0, Math.round(minutes));
};

const followUpValueToMinutes = (value: number, unit: FollowUpDelayUnit) => {
  const safe = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (unit === "days") return safe * 24 * 60;
  if (unit === "hours") return safe * 60;
  return safe;
};

const formatFollowUpDelay = (minutes?: number) => {
  const safe = Math.max(0, Math.round(Number(minutes ?? 0)));
  if (safe % (24 * 60) === 0 && safe >= 24 * 60) {
    const days = safe / (24 * 60);
    return `${days} ${days === 1 ? "dag" : "dagen"}`;
  }
  if (safe % 60 === 0 && safe >= 60) {
    const hours = safe / 60;
    return `${hours} ${hours === 1 ? "uur" : "uren"}`;
  }
  return `${safe} min`;
};

const AiAgents: React.FC = () => {
  const [agents, setAgents] = useState<AiAgent[]>(() => loadAgents());
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [editing, setEditing] = useState<AiAgent | null>(null);
  const [testingAgent, setTestingAgent] = useState<AiAgent | null>(null);
  const [testChannel, setTestChannel] = useState<"SMS" | "EMAIL">("SMS");
  const [testDraft, setTestDraft] = useState("");
  const [testMessages, setTestMessages] = useState<TestChatMessage[]>([]);
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [testError, setTestError] = useState<string | undefined>();
  const [testLoading, setTestLoading] = useState(false);
  const [testMeta, setTestMeta] = useState<{
    model?: string;
    totalTokens?: number;
    eur?: number;
    responseSpeed?: string;
    followUpLimitReached?: boolean;
    handoffRequired?: boolean;
    handoffReason?: string;
    safetyFlags?: string[];
  } | null>(null);
  const [editingError, setEditingError] = useState<string | undefined>();
  const [saveBusy, setSaveBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [stats, setStats] = useState<{
    overall: {
      count: number;
      avgCostEur: number;
      avgLatencyMs: number;
      handoffCount: number;
      handoffRate: number;
      followUpStops: number;
    };
    byAgent: Record<
      string,
      {
        count: number;
        avgCostEur: number;
        avgLatencyMs: number;
        handoffCount: number;
        handoffRate: number;
        followUpStops: number;
      }
    >;
  } | null>(null);
  const [handoffs, setHandoffs] = useState<Array<Record<string, unknown>>>([]);
  const [versions, setVersions] = useState<AiAgentVersion[]>([]);
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  const [knowledge, setKnowledge] = useState<AiAgentKnowledge[]>([]);
  const [knowledgeNoteTitle, setKnowledgeNoteTitle] = useState("");
  const [knowledgeNoteBody, setKnowledgeNoteBody] = useState("");
  const [evalSummary, setEvalSummary] = useState<{
    total: number;
    passed: number;
    failed: number;
    averageScore: number;
  } | null>(null);
  const [evalRuns, setEvalRuns] = useState<Array<Record<string, unknown>>>([]);
  const [evalCasesCount, setEvalCasesCount] = useState(0);
  const [tab, setTab] = useState<TabKey>("general");
  const [faqDraft, setFaqDraft] = useState({ question: "", answer: "" });
  const [websiteDraft, setWebsiteDraft] = useState("");
  const [criteriaDraft, setCriteriaDraft] = useState("");
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templateSearch, setTemplateSearch] = useState("");
  const [followUpMinDelayValue, setFollowUpMinDelayValue] = useState(20);
  const [followUpMinDelayUnit, setFollowUpMinDelayUnit] =
    useState<FollowUpDelayUnit>("minutes");
  const [followUpMaxDelayValue, setFollowUpMaxDelayValue] = useState(40);
  const [followUpMaxDelayUnit, setFollowUpMaxDelayUnit] =
    useState<FollowUpDelayUnit>("minutes");
  const firstMessageRef = React.useRef<HTMLTextAreaElement | null>(null);
  const firstMessageSelectionRef = React.useRef<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });
  const templatePickerRef = React.useRef<HTMLDivElement | null>(null);
  const templateSearchRef = React.useRef<HTMLInputElement | null>(null);

  const filteredTemplateFields = useMemo(() => {
    const query = templateSearch.trim().toLowerCase();
    if (!query) return CONTACT_TEMPLATE_FIELDS;
    return CONTACT_TEMPLATE_FIELDS.filter(
      (field) =>
        field.label.toLowerCase().includes(query) ||
        field.key.toLowerCase().includes(query) ||
        `{{${field.key}}}`.toLowerCase().includes(query)
    );
  }, [templateSearch]);

  const persist = (next: AiAgent[]) => {
    const normalized = next.map((agent) => normalizeAgent(agent));
    setAgents(normalized);
    saveAgents(normalized);
  };

  const syncFollowUpDelayInputs = (agent: AiAgent) => {
    const normalized = normalizeAgent(agent);
    const minMinutes = Math.max(0, Math.round(normalized.followUpDelayMinMinutes ?? 20));
    const maxMinutes = Math.max(minMinutes, Math.round(normalized.followUpDelayMaxMinutes ?? 40));
    const minUnit = followUpMinutesToUnit(minMinutes);
    const maxUnit = followUpMinutesToUnit(maxMinutes);
    setFollowUpMinDelayUnit(minUnit);
    setFollowUpMinDelayValue(followUpMinutesToValue(minMinutes, minUnit));
    setFollowUpMaxDelayUnit(maxUnit);
    setFollowUpMaxDelayValue(followUpMinutesToValue(maxMinutes, maxUnit));
  };

  const getLocationIdOrThrow = () => {
    if (!selectedLocationId) {
      throw new Error("Selecteer eerst een subaccount.");
    }
    return selectedLocationId;
  };

  const loadServerState = React.useCallback(async () => {
    if (!selectedLocationId) return;
    try {
      setLoadError(undefined);
      const [remoteAgents, remoteStats, remoteHandoffs, remoteCases, remoteRuns] =
        await Promise.all([
          fetchAgentsForLocation(selectedLocationId),
          fetchAgentStats(selectedLocationId),
          fetchAgentHandoffs(selectedLocationId, 50),
          fetchEvalCases(selectedLocationId),
          fetchEvalRuns(selectedLocationId, 30),
        ]);
      if (remoteAgents.length > 0) {
        persist(remoteAgents);
      } else {
        setAgents([]);
      }
      setStats({
        overall: remoteStats.overall,
        byAgent: remoteStats.byAgent,
      });
      setHandoffs(remoteHandoffs);
      setEvalCasesCount(remoteCases.length);
      setEvalRuns(remoteRuns);
    } catch (error) {
      setLoadError(
        error instanceof Error
          ? `${error.message} (fallback: lokale agents)`
          : "Kon agents niet laden. Lokale fallback actief."
      );
      setAgents(loadAgents());
    }
  }, [selectedLocationId]);

  const openNew = () => {
    const created = createAgent();
    setEditing(created);
    syncFollowUpDelayInputs(created);
    setEditingError(undefined);
    setTab("general");
    setFaqDraft({ question: "", answer: "" });
    setWebsiteDraft("");
    setCriteriaDraft("");
  };

  const openEdit = (agent: AiAgent) => {
    const normalized = normalizeAgent(agent);
    setEditing(normalized);
    syncFollowUpDelayInputs(normalized);
    setEditingError(undefined);
    setTab("general");
    setFaqDraft({ question: "", answer: "" });
    setWebsiteDraft("");
    setCriteriaDraft("");
    if (agent.id) {
      fetchAgentVersions(agent.id).then((list) => {
        setVersions(list);
        setRollbackTarget(list[0]?.version ?? null);
      }).catch(() => {
        setVersions([]);
        setRollbackTarget(null);
      });
      fetchAgentKnowledge(agent.id).then((list) => setKnowledge(list)).catch(() => setKnowledge([]));
    } else {
      setVersions([]);
      setRollbackTarget(null);
      setKnowledge([]);
    }
  };

  const openTest = (agent: AiAgent) => {
    const normalizedAgent = normalizeAgent(agent);
    const now = Date.now();
    const intro =
      (normalizedAgent.firstMessage?.trim()
        ? renderAgentTemplatePreview(normalizedAgent.firstMessage.trim())
        : "") ||
      `Hallo! Ik ben ${normalizedAgent.name}. Dit is een testomgeving waar je mijn configuratie kunt uitproberen. Stuur een bericht om te zien hoe ik reageer.`;
    setTestingAgent(normalizedAgent);
    setTestChannel("SMS");
    setTestDraft("");
    setShowSystemPrompt(false);
    setTestError(undefined);
    setTestMeta(null);
    setTestMessages([
      {
        id: `intro-${now}`,
        role: "agent",
        text: intro,
        timestamp: now,
      },
    ]);
  };

  const updateEditing = (patch: Partial<AiAgent>) => {
    setEditingError(undefined);
    setEditing((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const applySystemPromptTemplate = (template: SystemPromptTemplate) => {
    updateEditing({ systemPrompt: template.prompt });
  };

  const saveEditing = async () => {
    if (!editing) return;
    const minDelayMinutes = followUpValueToMinutes(
      followUpMinDelayValue,
      followUpMinDelayUnit
    );
    const maxDelayMinutes = Math.max(
      minDelayMinutes,
      followUpValueToMinutes(followUpMaxDelayValue, followUpMaxDelayUnit)
    );
    const normalized = normalizeAgent({
      ...editing,
      followUpScheduleHours: [],
      followUpDelayMinMinutes: minDelayMinutes,
      followUpDelayMaxMinutes: maxDelayMinutes,
    });
    if (!normalized.name?.trim()) {
      setEditingError("Geef de agent een naam.");
      return;
    }
    try {
      setSaveBusy(true);
      const locationId = getLocationIdOrThrow();
      const existing = agents.find((agent) => agent.id === normalized.id);
      const saved = existing
        ? await updateAgentOnServer(normalized.id, normalized, "Update via UI")
        : await createAgentForLocation(locationId, normalized, "Aangemaakt via UI");
      const next = existing
        ? agents.map((agent) => (agent.id === saved.id ? saved : agent))
        : [saved, ...agents];
      persist(next);
      setEditingError(undefined);
      setEditing(saved);
      syncFollowUpDelayInputs(saved);
      const [list, listKnowledgeItems] = await Promise.all([
        fetchAgentVersions(saved.id),
        fetchAgentKnowledge(saved.id),
      ]);
      setVersions(list);
      setRollbackTarget(list[0]?.version ?? null);
      setKnowledge(listKnowledgeItems);
      await loadServerState();
    } catch (error) {
      setEditingError(error instanceof Error ? error.message : "Opslaan mislukt.");
    } finally {
      setSaveBusy(false);
    }
  };

  const toggleAgent = (agent: AiAgent) => {
    const next = agents.map((item) => (item.id === agent.id ? { ...item, active: !item.active } : item));
    persist(next);
    updateAgentOnServer(agent.id, { ...agent, active: !agent.active }, "Toggle actief").catch(
      () => undefined
    );
  };

  const deleteAgent = (agent: AiAgent) => {
    archiveAgentOnServer(agent.id)
      .then(async () => {
        const next = agents.filter((item) => item.id !== agent.id);
        persist(next);
        if (editing?.id === agent.id) setEditing(null);
        await loadServerState();
      })
      .catch((error) => setLoadError(error instanceof Error ? error.message : "Verwijderen mislukt."));
  };

  const addFaq = () => {
    if (!editing || !faqDraft.question.trim() || !faqDraft.answer.trim()) return;
    const faqs = [...(editing.faqs ?? []), { ...faqDraft }];
    updateEditing({ faqs });
    setFaqDraft({ question: "", answer: "" });
  };

  const addWebsite = () => {
    if (!editing || !websiteDraft.trim()) return;
    const websites = [...(editing.websites ?? []), websiteDraft.trim()];
    updateEditing({ websites });
    setWebsiteDraft("");
  };

  const addCriteria = () => {
    if (!editing || !criteriaDraft.trim()) return;
    const qualificationCriteria = [
      ...(editing.qualificationCriteria ?? []),
      criteriaDraft.trim(),
    ];
    updateEditing({ qualificationCriteria });
    setCriteriaDraft("");
  };

  const rememberFirstMessageSelection = (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
    firstMessageSelectionRef.current = {
      start: event.currentTarget.selectionStart ?? 0,
      end: event.currentTarget.selectionEnd ?? 0,
    };
  };

  const insertTemplateField = (fieldKey: string) => {
    if (!editing) return;
    const token = `{{${fieldKey}}}`;
    const currentValue = editing.firstMessage ?? "";
    const textarea = firstMessageRef.current;
    const fallbackSelection = firstMessageSelectionRef.current;
    const start = textarea?.selectionStart ?? fallbackSelection.start ?? currentValue.length;
    const end = textarea?.selectionEnd ?? fallbackSelection.end ?? currentValue.length;
    const safeStart = Number.isFinite(start) ? start : currentValue.length;
    const safeEnd = Number.isFinite(end) ? end : currentValue.length;
    const nextValue =
      currentValue.slice(0, safeStart) + token + currentValue.slice(Math.max(safeStart, safeEnd));
    const nextCursor = safeStart + token.length;
    updateEditing({ firstMessage: nextValue });
    setTemplatePickerOpen(false);
    setTemplateSearch("");
    window.requestAnimationFrame(() => {
      if (!firstMessageRef.current) return;
      firstMessageRef.current.focus();
      firstMessageRef.current.setSelectionRange(nextCursor, nextCursor);
      firstMessageSelectionRef.current = { start: nextCursor, end: nextCursor };
    });
  };

  const formatTestTime = (timestamp: number) =>
    new Date(timestamp).toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit",
    });

  const runTest = async () => {
    if (!testingAgent) return;
    const text = testDraft.trim();
    if (!text) {
      return;
    }
    const leadMessage: TestChatMessage = {
      id: `lead-${Date.now()}`,
      role: "lead",
      text,
      timestamp: Date.now(),
    };
    const nextMessages = [...testMessages, leadMessage];
    setTestMessages(nextMessages);
    setTestDraft("");

    setTestLoading(true);
    setTestError(undefined);

    try {
      const response = await fetch("/api/agents/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationId: selectedLocationId ?? undefined,
          agentId: testingAgent.locationId ? testingAgent.id : undefined,
          leadName: "Test lead",
          channel: testChannel,
          history: nextMessages.map((item) => ({
            role: item.role,
            text: item.text,
          })),
          agent: normalizeAgent(testingAgent),
        }),
      });

      const data = await response
        .json()
        .catch(() => ({ error: "Onverwachte response." }));

      if (!response.ok) {
        throw new Error(data?.error || "Testen mislukt.");
      }

      const answer = (data?.suggestion?.text ?? "").trim();
      if (answer) {
        setTestMessages((prev) => [
          ...prev,
          {
            id: `agent-${Date.now()}`,
            role: "agent",
            text: answer,
            timestamp: Date.now(),
          },
        ]);
      }
      setTestMeta({
        model: data?.suggestion?.cost?.model,
        totalTokens: data?.suggestion?.usage?.totalTokens,
        eur: data?.suggestion?.cost?.eur,
        responseSpeed: data?.suggestion?.policy?.responseSpeed,
        followUpLimitReached: data?.suggestion?.policy?.followUpLimitReached,
        handoffRequired: data?.suggestion?.policy?.handoffRequired,
        handoffReason: data?.suggestion?.policy?.handoffReason,
        safetyFlags: data?.suggestion?.policy?.safetyFlags,
      });
    } catch (error) {
      setTestError(error instanceof Error ? error.message : "Testen mislukt.");
    } finally {
      setTestLoading(false);
    }
  };

  const handlePublish = async (agent: AiAgent) => {
    try {
      const saved = await publishAgentOnServer(agent.id, "Gepubliceerd via AI Agents");
      persist(agents.map((item) => (item.id === saved.id ? saved : item)));
      if (editing?.id === saved.id) {
        setEditing(saved);
        syncFollowUpDelayInputs(saved);
      }
      await loadServerState();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Publiceren mislukt.");
    }
  };

  const handleRollback = async () => {
    if (!editing || !rollbackTarget) return;
    try {
      const saved = await rollbackAgentOnServer(
        editing.id,
        rollbackTarget,
        true,
        `Rollback naar v${rollbackTarget}`
      );
      setEditing(saved);
      syncFollowUpDelayInputs(saved);
      persist(agents.map((item) => (item.id === saved.id ? saved : item)));
      const [list, listKnowledgeItems] = await Promise.all([
        fetchAgentVersions(saved.id),
        fetchAgentKnowledge(saved.id),
      ]);
      setVersions(list);
      setRollbackTarget(list[0]?.version ?? null);
      setKnowledge(listKnowledgeItems);
      await loadServerState();
    } catch (error) {
      setEditingError(error instanceof Error ? error.message : "Rollback mislukt.");
    }
  };

  const handleRefreshKnowledge = async () => {
    if (!editing) return;
    try {
      await refreshAllWebsiteKnowledge(editing.id);
      const list = await fetchAgentKnowledge(editing.id);
      setKnowledge(list);
    } catch (error) {
      setEditingError(error instanceof Error ? error.message : "Knowledge refresh mislukt.");
    }
  };

  const handleAddKnowledgeNote = async () => {
    if (!editing) return;
    const content = knowledgeNoteBody.trim();
    if (!content) return;
    try {
      await addKnowledgeNote(editing.id, {
        title: knowledgeNoteTitle.trim() || undefined,
        content,
        sourceType: "note",
      });
      setKnowledgeNoteBody("");
      setKnowledgeNoteTitle("");
      const list = await fetchAgentKnowledge(editing.id);
      setKnowledge(list);
    } catch (error) {
      setEditingError(error instanceof Error ? error.message : "Note opslaan mislukt.");
    }
  };

  const handleDeleteKnowledge = async (knowledgeId: string) => {
    if (!editing) return;
    try {
      await deleteKnowledge(knowledgeId);
      const list = await fetchAgentKnowledge(editing.id);
      setKnowledge(list);
    } catch (error) {
      setEditingError(error instanceof Error ? error.message : "Knowledge verwijderen mislukt.");
    }
  };

  const handleRefreshSingleKnowledge = async (knowledgeId: string) => {
    if (!editing) return;
    try {
      await refreshKnowledge(knowledgeId);
      const list = await fetchAgentKnowledge(editing.id);
      setKnowledge(list);
    } catch (error) {
      setEditingError(error instanceof Error ? error.message : "Knowledge refresh mislukt.");
    }
  };

  const handleRunEval = async (agent: AiAgent) => {
    if (!selectedLocationId) return;
    try {
      const result = await runAgentEvals(agent.id, selectedLocationId);
      setEvalSummary(result.summary);
      await loadServerState();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Evaluatie run mislukt.");
    }
  };

  const activeAgents = useMemo(() => agents.filter((agent) => agent.active), [agents]);

  const subaccountOptions = useMemo(() => {
    const preferred = ["Vastgoed", "Dakwerken", "Gevelwerken"];
    const filtered = locations.filter((loc) => preferred.includes(loc.name));
    return filtered.length ? filtered : locations;
  }, [locations]);

  React.useEffect(() => {
    const load = async () => {
      const response = await fetch("/api/locations");
      const data = await response.json().catch(() => ({}));
      setLocations(data.locations ?? []);
    };
    load();
  }, []);

  React.useEffect(() => {
    if (!selectedLocationId && subaccountOptions.length > 0) {
      setSelectedLocationId(subaccountOptions[0].id);
    }
  }, [selectedLocationId, subaccountOptions]);

  React.useEffect(() => {
    if (!selectedLocationId) return;
    loadServerState();
  }, [selectedLocationId, loadServerState]);

  React.useEffect(() => {
    if (!templatePickerOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (templatePickerRef.current?.contains(target)) return;
      setTemplatePickerOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTemplatePickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [templatePickerOpen]);

  React.useEffect(() => {
    if (!templatePickerOpen) return;
    templateSearchRef.current?.focus();
  }, [templatePickerOpen]);

  React.useEffect(() => {
    if (tab !== "prompt" || !editing) {
      setTemplatePickerOpen(false);
      setTemplateSearch("");
    }
  }, [tab, editing]);

  return (
    <div className="ghl-shell ghl-shell--ai-agents">
      <aside className="ghl-sidebar">
        <div className="ghl-brand">
          <span className="ghl-brand__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="ghl-icon">
              <path d="M4 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm6-3h4a2 2 0 0 1 2 2v1H8V6a2 2 0 0 1 2-2z" />
            </svg>
          </span>
          <div>
            <strong>LeadPilot</strong>
            <span>AI Agents</span>
          </div>
        </div>

        <div className="ghl-account">
          <label>Subaccount</label>
          <select
            className="input"
            value={selectedLocationId ?? ""}
            onChange={(event) => setSelectedLocationId(event.target.value)}
          >
            {subaccountOptions.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </div>

        <nav className="ghl-nav">
          <NavLink
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
            to="/dashboard"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z" />
              </svg>
            </span>
            Dashboard
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
            to="/leads"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M7.5 12a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm9 0a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM3 20.5c0-3 3-5.5 6.5-5.5S16 17.5 16 20.5V22H3v-1.5zm9.5 1.5v-1.5c0-1.6-.6-3-1.6-4.1.8-.3 1.7-.4 2.6-.4 3.6 0 6.5 2.5 6.5 5.5V22h-7.5z" />
              </svg>
            </span>
            Leads
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
            to="/conversations"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M4 5h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V7a2 2 0 0 1 2-2zm3 4h10v2H7V9zm0 4h7v2H7v-2z" />
              </svg>
            </span>
            Conversations
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
            to="/ai-agents"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2zm7 9l.9 2.6L22 14l-2.1.4L19 17l-.9-2.6L16 14l2.1-.4L19 11zM5 13l.9 2.6L8 16l-2.1.4L5 19l-.9-2.6L2 16l2.1-.4L5 13z" />
              </svg>
            </span>
            AI Agents
          </NavLink>
          <NavLink
            className={({ isActive }) =>
              `ghl-nav__item ${isActive ? "ghl-nav__item--active" : ""}`
            }
            to="/workflows"
          >
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M9 3h6v4h2a2 2 0 0 1 2 2v2h-4V9H9v4H5V9a2 2 0 0 1 2-2h2V3zm-4 12h4v4H7a2 2 0 0 1-2-2v-2zm6 0h4v6h-4v-6zm6 0h4v2a2 2 0 0 1-2 2h-2v-4z" />
              </svg>
            </span>
            Workflows
          </NavLink>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M7 2h2v3H7V2zm8 0h2v3h-2V2zM4 5h16a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 6h16v9H4v-9z" />
              </svg>
            </span>
            Calendar
          </button>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M4 20V4h2v16H4zm7 0V9h2v11h-2zm7 0V13h2v7h-2z" />
              </svg>
            </span>
            Analytics
          </button>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M3 6h18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm0 4h18V8H3v2zm4 6h4v2H7v-2z" />
              </svg>
            </span>
            Billing
          </button>
          <button className="ghl-nav__item">
            <span className="ghl-nav__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" className="ghl-icon">
                <path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm8.4 4a6.4 6.4 0 0 0-.1-1l2.1-1.6-2-3.5-2.5 1a7.7 7.7 0 0 0-1.7-1l-.3-2.7h-4l-.3 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1-2 3.5L3.6 11a6.4 6.4 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.7 7.7 0 0 0 1.7 1l.3 2.7h4l.3-2.7a7.7 7.7 0 0 0 1.7-1l2.5 1 2-3.5-2.1-1.6c.1-.3.1-.6.1-1z" />
              </svg>
            </span>
            Settings
          </button>
        </nav>
      </aside>

      <main className="ghl-main ghl-main--ai-agents">
        <header className="ghl-main__header ghl-main__header--ai-agents">
          <div>
            <h1>AI Agents</h1>
            <p>Configureer en beheer je AI sales agents</p>
          </div>
          <div className="header-actions">
            <button className="button" onClick={openNew}>
              + Nieuwe agent
            </button>
          </div>
        </header>

        <section className="panel panel--ai-agents ai-agents">
          <div className="panel__body">
            {loadError ? <div className="alert alert--error">{loadError}</div> : null}
            {stats ? (
              <div className="alert alert--note">
                {stats.overall.count} runs in laatste 30 dagen • avg kost €{stats.overall.avgCostEur.toFixed(4)} • handoff{" "}
                {Math.round(stats.overall.handoffRate * 100)}% • gemiddelde latency {stats.overall.avgLatencyMs} ms
              </div>
            ) : null}
            {evalSummary ? (
              <div className="alert alert--note">
                Evaluatie resultaat: {evalSummary.passed}/{evalSummary.total} geslaagd • avg score {evalSummary.averageScore}
              </div>
            ) : null}
            <div className="ghl-muted">
              {evalCasesCount} evaluatiecase(s) actief • {evalRuns.length} recente evaluatierun(s)
            </div>
            {handoffs.length > 0 ? (
              <div className="alert alert--note">
                {handoffs.length} recente handoff(s) gedetecteerd. Laatste reden:{" "}
                {String(handoffs[0]?.handoff_reason ?? "Onbekend")}
              </div>
            ) : null}
            <div className="agent-grid agent-grid--ai-agents">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className={`agent-card agent-card--ai-agents ${agent.active ? "" : "agent-card--inactive"}`}
                >
                  <div className="agent-card__top">
                    <div className="agent-card__identity">
                      <div className="agent-icon agent-icon--ai-agents" aria-hidden="true">
                        <svg viewBox="0 0 24 24" className="ghl-icon">
                          <path d="M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zm4-6h2v3h-2V2zm-3 12h2m4 0h2" />
                        </svg>
                      </div>
                      <div className="agent-card__title-wrap">
                        <strong>{agent.name}</strong>
                        <div className="agent-card__tags">
                          <span className="agent-tag">{agent.primaryGoal ?? "Agent"}</span>
                          <span className={`agent-tag agent-tag--status agent-tag--${agent.status ?? "draft"}`}>
                            {agent.status ?? "draft"} v{agent.currentVersion ?? 1}
                          </span>
                        </div>
                      </div>
                    </div>
                    <label className="switch agent-switch" title={agent.active ? "Agent actief" : "Agent inactief"}>
                      <input
                        type="checkbox"
                        checked={!!agent.active}
                        onChange={() => toggleAgent(agent)}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                  <p className="agent-desc">{agent.description ?? "Geen beschrijving."}</p>

                  <div className="agent-divider" />

                  <div className="agent-metrics">
                    <div className="agent-metric agent-metric--bar">
                      <span>Assertiviteit</span>
                      <div className="agent-bar">
                        <div style={{ width: `${agent.assertiveness ?? 0}%` }} />
                      </div>
                      <strong>{agent.assertiveness ?? 0}%</strong>
                    </div>
                    <div className="agent-metric">
                      <span>Response snelheid</span>
                      <strong>{agent.responseSpeed ?? "Natural"}</strong>
                    </div>
                    <div className="agent-metric">
                      <span>Max follow-ups</span>
                      <strong>{agent.maxFollowUps ?? 0}x</strong>
                      <small className="field-help">
                        {agent.followUpAutoEnabled === false
                          ? "Auto follow-ups uit"
                          : `${formatFollowUpDelay(agent.followUpDelayMinMinutes)} - ${formatFollowUpDelay(
                              agent.followUpDelayMaxMinutes
                            )}`}
                      </small>
                    </div>
                  </div>

                  <div className="agent-divider" />

                  <div className="agent-criteria-block">
                    <span className="agent-criteria-title">Kwalificatiecriteria:</span>
                    <div className="agent-criteria">
                      {(agent.qualificationCriteria ?? []).slice(0, 2).map((item) => (
                        <span key={item} className="agent-pill">
                          {item}
                        </span>
                      ))}
                      {(agent.qualificationCriteria ?? []).length > 2 ? (
                        <span className="agent-pill">+{(agent.qualificationCriteria ?? []).length - 2}</span>
                      ) : null}
                      {(agent.qualificationCriteria ?? []).length === 0 ? (
                        <span className="agent-pill agent-pill--muted">Geen criteria</span>
                      ) : null}
                    </div>
                  </div>

                  <div className="agent-divider" />

                  <div className="agent-actions agent-actions--ai-agents">
                    <button className="button agent-action-primary" onClick={() => openTest(agent)}>
                      <svg viewBox="0 0 24 24" className="ghl-icon" aria-hidden="true">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      Testen
                    </button>
                    <div className="agent-action-icons">
                      <button
                        className="button agent-action-icon"
                        onClick={() => handleRunEval(agent)}
                        title="Evaluatie run"
                      >
                        <svg viewBox="0 0 24 24" className="ghl-icon" aria-hidden="true">
                          <path d="M9 5h6m-7 4h8m-8 4h8m-9 6h10a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" />
                        </svg>
                      </button>
                      <button
                        className="button agent-action-icon"
                        onClick={() => handlePublish(agent)}
                        title="Publish agent"
                      >
                        <svg viewBox="0 0 24 24" className="ghl-icon" aria-hidden="true">
                          <path d="M12 3l5 5h-3v7h-4V8H7l5-5zm-7 14h14v4H5v-4z" />
                        </svg>
                      </button>
                      <button
                        className="button agent-action-icon"
                        onClick={() => openEdit(agent)}
                        title="Agent bewerken"
                      >
                        <svg viewBox="0 0 24 24" className="ghl-icon" aria-hidden="true">
                          <path d="M4 17v3h3l9-9-3-3-9 9zm11-11 3 3 2-2-3-3-2 2z" />
                        </svg>
                      </button>
                      <button
                        className="button agent-action-icon agent-action-icon--danger"
                        onClick={() => deleteAgent(agent)}
                        title="Agent archiveren"
                      >
                        <svg viewBox="0 0 24 24" className="ghl-icon" aria-hidden="true">
                          <path d="M4 7h16M9 7V5h6v2m-7 3v8m4-8v8m4-8v8M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              {agents.length === 0 ? <div className="empty">Nog geen agents.</div> : null}
            </div>

            {activeAgents.length === 0 ? (
              <div className="alert alert--note">Geen actieve agents. Activeer minstens één agent.</div>
            ) : null}
          </div>
        </section>
      </main>

      {editing ? (
        <div className="modal modal--ai-agents">
          <div className="modal__content modal__content--large modal__content--ai-agents">
            <div className="modal__header">
              <div>
                <h3>Agent bewerken</h3>
                <p>Configureer hoe deze AI agent zich gedraagt in gesprekken</p>
              </div>
              <button className="button button--ghost" onClick={() => setEditing(null)}>
                ✕
              </button>
            </div>

            <div className="modal__tabs">
              {[
                ["general", "Algemeen"],
                ["prompt", "Prompt"],
                ["knowledge", "Kennis"],
                ["behavior", "Gedrag"],
                ["qualification", "Kwalificatie"],
                ["safety", "Safety"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  className={`tab ${tab === key ? "tab--active" : ""}`}
                  onClick={() => setTab(key as TabKey)}
                >
                  {label}
                </button>
              ))}
            </div>
            {editingError ? <div className="alert alert--error">{editingError}</div> : null}
            <div className="alert alert--note">
              Status: <strong>{editing.status ?? "draft"}</strong> • huidige versie{" "}
              <strong>v{editing.currentVersion ?? 1}</strong> • gepubliceerde versie{" "}
              <strong>v{editing.publishedVersion ?? 0}</strong>
            </div>

            <div className="modal__body">
              {tab === "general" ? (
                <div className="form-grid">
                  <div className="field">
                    <label>Naam *</label>
                    <input
                      className="input"
                      value={editing.name}
                      onChange={(event) => updateEditing({ name: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Beschrijving</label>
                    <textarea
                      className="textarea"
                      value={editing.description ?? ""}
                      onChange={(event) => updateEditing({ description: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Primair doel</label>
                    <select
                      className="input"
                      value={editing.primaryGoal ?? ""}
                      onChange={(event) => updateEditing({ primaryGoal: event.target.value })}
                    >
                      <option>Kwalificeren</option>
                      <option>Afspraken plannen</option>
                      <option>Nurturing</option>
                      <option>Support</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Taal</label>
                    <select
                      className="input"
                      value={editing.language ?? ""}
                      onChange={(event) => updateEditing({ language: event.target.value })}
                    >
                      <option>Nederlands</option>
                      <option>Engels</option>
                      <option>Frans</option>
                    </select>
                  </div>
                  <div className="field field--toggle">
                    <label>Actief</label>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={!!editing.active}
                        onChange={() => updateEditing({ active: !editing.active })}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                </div>
              ) : null}

              {tab === "prompt" ? (
                <div className="form-grid">
                  <div className="field">
                    <label>Voorbeeld prompts</label>
                    <div className="agent-prompt-template-grid">
                      {SYSTEM_PROMPT_TEMPLATES.map((template) => (
                        <div
                          key={template.id}
                          className={`agent-prompt-template-card${
                            (editing.systemPrompt ?? "").trim() === template.prompt.trim()
                              ? " agent-prompt-template-card--active"
                              : ""
                          }`}
                        >
                          <div className="agent-prompt-template-card__head">
                            <strong>{template.title}</strong>
                            <span>{template.useCase}</span>
                          </div>
                          <p>{template.summary}</p>
                          <button
                            type="button"
                            className="button button--ghost"
                            onClick={() => applySystemPromptTemplate(template)}
                          >
                            {(editing.systemPrompt ?? "").trim() === template.prompt.trim()
                              ? "Geselecteerd"
                              : "Gebruik voorbeeld"}
                          </button>
                        </div>
                      ))}
                    </div>
                    <p className="agent-template-help">
                      Klik op een voorbeeld om de volledige system prompt te laden en daarna op
                      maat aan te passen.
                    </p>
                  </div>
                  <div className="field">
                    <label>System prompt</label>
                    <textarea
                      className="textarea"
                      value={editing.systemPrompt ?? ""}
                      onChange={(event) => updateEditing({ systemPrompt: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <div className="agent-template-label-row" ref={templatePickerRef}>
                      <label>Eerste bericht</label>
                      <button
                        type="button"
                        className="button button--ghost agent-template-picker-toggle"
                        onClick={() => {
                          setTemplatePickerOpen((prev) => !prev);
                          setTemplateSearch("");
                        }}
                      >
                        Labels
                      </button>
                      {templatePickerOpen ? (
                        <div className="agent-template-picker">
                          <input
                            ref={templateSearchRef}
                            className="input"
                            placeholder="Zoek veld of placeholder..."
                            value={templateSearch}
                            onChange={(event) => setTemplateSearch(event.target.value)}
                          />
                          <div className="agent-template-picker__list">
                            {filteredTemplateFields.map((field) => (
                              <button
                                key={field.key}
                                type="button"
                                className="agent-template-picker__item"
                                onClick={() => insertTemplateField(field.key)}
                              >
                                <strong>{field.label}</strong>
                                <span>{`{{${field.key}}}`}</span>
                              </button>
                            ))}
                            {filteredTemplateFields.length === 0 ? (
                              <div className="agent-template-picker__empty">
                                Geen velden gevonden voor deze zoekterm.
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <textarea
                      ref={firstMessageRef}
                      className="textarea"
                      value={editing.firstMessage ?? ""}
                      onChange={(event) => updateEditing({ firstMessage: event.target.value })}
                      onSelect={rememberFirstMessageSelection}
                      onKeyUp={rememberFirstMessageSelection}
                      onClick={rememberFirstMessageSelection}
                    />
                    <p className="agent-template-help">
                      Klik op <strong>Labels</strong> om een custom veld in te voegen. Voorbeelden:{" "}
                      <code>{`{{contact.first_name}}`}</code>, <code>{`{{contact.full_name}}`}</code>,{" "}
                      <code>{`{{contact.email}}`}</code>, <code>{`{{contact.phone}}`}</code>.
                    </p>
                  </div>
                  <div className="field">
                    <label>Tone of voice</label>
                    <input
                      className="input"
                      value={editing.toneOfVoice ?? ""}
                      onChange={(event) => updateEditing({ toneOfVoice: event.target.value })}
                    />
                  </div>
                </div>
              ) : null}

              {tab === "knowledge" ? (
                <div className="form-grid">
                  <div className="field">
                    <label>FAQ toevoegen</label>
                    <input
                      className="input"
                      placeholder="Vraag"
                      value={faqDraft.question}
                      onChange={(event) => setFaqDraft({ ...faqDraft, question: event.target.value })}
                    />
                    <textarea
                      className="textarea"
                      placeholder="Antwoord"
                      value={faqDraft.answer}
                      onChange={(event) => setFaqDraft({ ...faqDraft, answer: event.target.value })}
                    />
                    <button className="button button--ghost" onClick={addFaq}>
                      Vraag toevoegen
                    </button>
                    <div className="list">
                      {(editing.faqs ?? []).map((faq, index) => (
                        <div key={`${faq.question}-${index}`} className="list-item">
                          <div>
                            <strong>{faq.question}</strong>
                            <p>{faq.answer}</p>
                          </div>
                          <button
                            className="button button--ghost"
                            onClick={() =>
                              updateEditing({
                                faqs: (editing.faqs ?? []).filter((_, i) => i !== index),
                              })
                            }
                          >
                            <svg viewBox="0 0 24 24" className="ghl-icon icon-muted">
                              <path d="M4 7h16M9 7V5h6v2m-7 3v8m4-8v8m4-8v8M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="field">
                    <label>Website toevoegen</label>
                    <div className="field-row">
                      <input
                        className="input"
                        placeholder="https://jouwbedrijf.nl/faq"
                        value={websiteDraft}
                        onChange={(event) => setWebsiteDraft(event.target.value)}
                      />
                      <button className="button button--ghost" onClick={addWebsite}>
                        + Toevoegen
                      </button>
                    </div>
                    <div className="list">
                      {(editing.websites ?? []).map((site) => (
                        <div key={site} className="list-item">
                          <span>{site}</span>
                          <button
                            className="button button--ghost"
                            onClick={() =>
                              updateEditing({
                                websites: (editing.websites ?? []).filter((item) => item !== site),
                              })
                            }
                          >
                            <svg viewBox="0 0 24 24" className="ghl-icon icon-muted">
                              <path d="M4 7h16M9 7V5h6v2m-7 3v8m4-8v8m4-8v8M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="field">
                    <label>PDF upload</label>
                    <div className="upload-placeholder">Upload volgt later</div>
                  </div>
                  <div className="field">
                    <label>Kennis index (logs)</label>
                    <div className="field-row">
                      <button className="button button--ghost" onClick={handleRefreshKnowledge}>
                        Sync website bronnen
                      </button>
                    </div>
                    <div className="list">
                      {knowledge.map((item) => (
                        <div key={item.id} className="list-item">
                          <div>
                            <strong>{item.title ?? item.sourceUrl ?? item.sourceType}</strong>
                            <p>
                              {item.sourceType} • Laatste refresh:{" "}
                              {item.lastRefreshedAt
                                ? new Date(item.lastRefreshedAt).toLocaleString("nl-BE")
                                : "nvt"}
                            </p>
                          </div>
                          <div className="field-row">
                            {item.sourceType === "website" ? (
                              <button
                                className="button button--ghost"
                                onClick={() => handleRefreshSingleKnowledge(item.id)}
                              >
                                Refresh
                              </button>
                            ) : null}
                            <button
                              className="button button--ghost"
                              onClick={() => handleDeleteKnowledge(item.id)}
                            >
                              Verwijder
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="field">
                      <label>Nieuwe note</label>
                      <input
                        className="input"
                        value={knowledgeNoteTitle}
                        placeholder="Titel"
                        onChange={(event) => setKnowledgeNoteTitle(event.target.value)}
                      />
                      <textarea
                        className="textarea"
                        value={knowledgeNoteBody}
                        placeholder="Interne kennis note"
                        onChange={(event) => setKnowledgeNoteBody(event.target.value)}
                      />
                      <button className="button button--ghost" onClick={handleAddKnowledgeNote}>
                        Note opslaan
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              {tab === "behavior" ? (
                <div className="form-grid">
                  <div className="field">
                    <label>Assertiviteit</label>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={editing.assertiveness ?? 0}
                      onChange={(event) => updateEditing({ assertiveness: Number(event.target.value) })}
                    />
                    <div className="range-label">{editing.assertiveness ?? 0}%</div>
                  </div>
                  <div className="field">
                    <label>Response snelheid</label>
                    <select
                      className="input"
                      value={editing.responseSpeed ?? "Natural"}
                      onChange={(event) => updateEditing({ responseSpeed: event.target.value })}
                    >
                      <option>Instant</option>
                      <option>Natural</option>
                      <option>Slow</option>
                    </select>
                  </div>
                  <div className="field field--inline">
                    <div>
                      <label>Max follow-ups</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={20}
                        value={editing.maxFollowUps ?? 0}
                        disabled={editing.followUpAutoEnabled === false}
                        onChange={(event) => updateEditing({ maxFollowUps: Number(event.target.value) })}
                      />
                    </div>
                    <div>
                      <label>Automatische follow-ups</label>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={editing.followUpAutoEnabled !== false}
                          onChange={() =>
                            updateEditing({
                              followUpAutoEnabled: !(editing.followUpAutoEnabled !== false),
                            })
                          }
                        />
                        <span className="slider" />
                      </label>
                    </div>
                  </div>
                  <div className="field">
                    <label>Wachttijd voor opvolging</label>
                    <small className="field-help">
                      Na hoeveel tijd zonder reactie de agent automatisch opvolgt.
                    </small>
                    <div className="field-row">
                      <div className="field">
                        <label>Minimum</label>
                        <div className="field-row">
                          <input
                            className="input"
                            type="number"
                            min={0}
                            max={43200}
                            value={followUpMinDelayValue}
                            disabled={editing.followUpAutoEnabled === false}
                            onChange={(event) =>
                              setFollowUpMinDelayValue(
                                Math.max(0, Number(event.target.value) || 0)
                              )
                            }
                          />
                          <select
                            className="input"
                            value={followUpMinDelayUnit}
                            disabled={editing.followUpAutoEnabled === false}
                            onChange={(event) =>
                              setFollowUpMinDelayUnit(
                                event.target.value as FollowUpDelayUnit
                              )
                            }
                          >
                            <option value="minutes">min</option>
                            <option value="hours">uur</option>
                            <option value="days">dagen</option>
                          </select>
                        </div>
                      </div>
                      <div className="field">
                        <label>Maximum</label>
                        <div className="field-row">
                          <input
                            className="input"
                            type="number"
                            min={0}
                            max={43200}
                            value={followUpMaxDelayValue}
                            disabled={editing.followUpAutoEnabled === false}
                            onChange={(event) =>
                              setFollowUpMaxDelayValue(
                                Math.max(0, Number(event.target.value) || 0)
                              )
                            }
                          />
                          <select
                            className="input"
                            value={followUpMaxDelayUnit}
                            disabled={editing.followUpAutoEnabled === false}
                            onChange={(event) =>
                              setFollowUpMaxDelayUnit(
                                event.target.value as FollowUpDelayUnit
                              )
                            }
                          >
                            <option value="minutes">min</option>
                            <option value="hours">uur</option>
                            <option value="days">dagen</option>
                          </select>
                        </div>
                      </div>
                    </div>
                    <small className="field-help">
                      De agent kiest willekeurig een moment tussen minimum en maximum.
                    </small>
                  </div>
                </div>
              ) : null}

              {tab === "qualification" ? (
                <div className="form-grid">
                  <div className="field">
                    <label>Kwalificatiecriteria</label>
                    <div className="field-row">
                      <input
                        className="input"
                        placeholder="Bijv: Budget €5.000+"
                        value={criteriaDraft}
                        onChange={(event) => setCriteriaDraft(event.target.value)}
                      />
                      <button className="button button--ghost" onClick={addCriteria}>
                        +
                      </button>
                    </div>
                    <div className="list">
                      {(editing.qualificationCriteria ?? []).map((item) => (
                        <div key={item} className="list-item">
                          <span>{item}</span>
                          <button
                            className="button button--ghost"
                            onClick={() =>
                              updateEditing({
                                qualificationCriteria: (editing.qualificationCriteria ?? []).filter(
                                  (crit) => crit !== item
                                ),
                              })
                            }
                          >
                            <svg viewBox="0 0 24 24" className="ghl-icon icon-muted">
                              <path d="M4 7h16M9 7V5h6v2m-7 3v8m4-8v8m4-8v8M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
                            </svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}

              {tab === "safety" ? (
                <div className="form-grid">
                  <div className="field field--toggle">
                    <label>Handoff actief</label>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={editing.handoffEnabled !== false}
                        onChange={() =>
                          updateEditing({ handoffEnabled: !(editing.handoffEnabled !== false) })
                        }
                      />
                      <span className="slider" />
                    </label>
                  </div>
                  <div className="field">
                    <label>Handoff keywords (1 per lijn)</label>
                    <textarea
                      className="textarea"
                      value={(editing.handoffKeywords ?? []).join("\n")}
                      onChange={(event) =>
                        updateEditing({
                          handoffKeywords: event.target.value
                            .split("\n")
                            .map((item) => item.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </div>
                  <div className="field field--toggle">
                    <label>Auto markeer gesprekstatus</label>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={editing.autoMarkOutcomes !== false}
                        onChange={() =>
                          updateEditing({
                            autoMarkOutcomes: !(editing.autoMarkOutcomes !== false),
                          })
                        }
                      />
                      <span className="slider" />
                    </label>
                  </div>
                  <div className="field field--inline">
                    <div>
                      <label>Stage: Sales overdracht</label>
                      <input
                        className="input"
                        value={editing.salesHandoverStage ?? "Sales Overdracht"}
                        onChange={(event) =>
                          updateEditing({ salesHandoverStage: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label>Stage: Review nodig</label>
                      <input
                        className="input"
                        value={editing.reviewNeededStage ?? "Review Nodig"}
                        onChange={(event) =>
                          updateEditing({ reviewNeededStage: event.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>Stage: Lost</label>
                    <input
                      className="input"
                      value={editing.lostStage ?? "Lost"}
                      onChange={(event) => updateEditing({ lostStage: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label>Lost analyse prompt</label>
                    <textarea
                      className="textarea"
                      placeholder="Voorbeeld: Markeer als Lost bij expliciete stopzetting, geen interesse of duidelijke afwijzing. Markeer niet als Lost bij twijfel of uitstel."
                      value={editing.lostDecisionPrompt ?? ""}
                      onChange={(event) =>
                        updateEditing({ lostDecisionPrompt: event.target.value })
                      }
                    />
                    <p className="field-help">
                      Deze instructie bepaalt hoe de AI beslist of een lead op Lost moet.
                    </p>
                  </div>
                  <div className="field">
                    <label>Lost keywords fallback (1 per lijn)</label>
                    <textarea
                      className="textarea"
                      value={(editing.lostKeywords ?? []).join("\n")}
                      onChange={(event) =>
                        updateEditing({
                          lostKeywords: event.target.value
                            .split("\n")
                            .map((item) => item.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>Verboden claims/frasen (1 per lijn)</label>
                    <textarea
                      className="textarea"
                      value={(editing.complianceBlockedPhrases ?? []).join("\n")}
                      onChange={(event) =>
                        updateEditing({
                          complianceBlockedPhrases: event.target.value
                            .split("\n")
                            .map((item) => item.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </div>
                  <div className="field field--toggle">
                    <label>SMS opt-in verplicht</label>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={editing.requireOptInForSms !== false}
                        onChange={() =>
                          updateEditing({
                            requireOptInForSms: !(editing.requireOptInForSms !== false),
                          })
                        }
                      />
                      <span className="slider" />
                    </label>
                  </div>
                  <div className="field field--inline">
                    <div>
                      <label>Max reply chars</label>
                      <input
                        className="input"
                        type="number"
                        min={120}
                        max={2000}
                        value={editing.maxReplyChars ?? 700}
                        onChange={(event) =>
                          updateEditing({ maxReplyChars: Number(event.target.value) })
                        }
                      />
                    </div>
                    <div>
                      <label>Kwalificatie mode</label>
                      <select
                        className="input"
                        value={editing.qualificationCriteriaMode ?? "assist"}
                        onChange={(event) =>
                          updateEditing({ qualificationCriteriaMode: event.target.value })
                        }
                      >
                        <option value="assist">Assist</option>
                        <option value="strict">Strict</option>
                      </select>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="modal__footer">
              <button className="button button--ghost" onClick={() => setEditing(null)}>
                Annuleren
              </button>
              <button
                className="button button--ghost"
                onClick={() => editing && handlePublish(editing)}
                disabled={saveBusy}
              >
                Publish
              </button>
              <select
                className="input"
                style={{ maxWidth: 150 }}
                value={rollbackTarget ?? ""}
                onChange={(event) => setRollbackTarget(Number(event.target.value) || null)}
              >
                <option value="">Rollback</option>
                {versions.map((version) => (
                  <option key={version.id} value={version.version}>
                    v{version.version}
                  </option>
                ))}
              </select>
              <button
                className="button button--ghost"
                onClick={handleRollback}
                disabled={saveBusy || !rollbackTarget}
              >
                Rollback
              </button>
              <button className="button" onClick={saveEditing} disabled={saveBusy}>
                {saveBusy ? "Opslaan..." : "Opslaan"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {testingAgent ? (
        <div className="modal modal--ai-agents">
          <div className="modal__content modal__content--large modal__content--ai-agents ai-test-modal">
            <div className="ai-test-header">
              <div className="ai-test-header__left">
                <span className="ai-test-header__avatar" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="ghl-icon">
                    <path d="M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zm4-6h2v3h-2V2zm-3 12h2m4 0h2" />
                  </svg>
                </span>
                <div>
                  <div className="ai-test-header__title-row">
                    <strong>{testingAgent.name}</strong>
                    <span className="ai-test-header__mode">Test Mode</span>
                  </div>
                  <p>{testingAgent.toneOfVoice ?? "Professioneel maar vriendelijk"}</p>
                </div>
              </div>
              <div className="ai-test-header__right">
                <span>Assertiviteit: {testingAgent.assertiveness ?? 0}%</span>
              </div>
              <button
                className="button button--ghost ai-test-close"
                onClick={() => setTestingAgent(null)}
                aria-label="Sluiten"
              >
                ✕
              </button>
            </div>

            <div className="ai-test-body">
              {testMessages.map((item) => (
                <div
                  key={item.id}
                  className={`ai-test-message ${item.role === "agent" ? "ai-test-message--agent" : "ai-test-message--lead"}`}
                >
                  {item.role === "agent" ? (
                    <span className="ai-test-message__avatar" aria-hidden="true">
                      <svg viewBox="0 0 24 24" className="ghl-icon">
                        <path d="M7 8h10a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zm4-6h2v3h-2V2zm-3 12h2m4 0h2" />
                      </svg>
                    </span>
                  ) : null}
                  <div className="ai-test-message__bubble">
                    <p>{item.text}</p>
                    <span>{formatTestTime(item.timestamp)}</span>
                  </div>
                </div>
              ))}

              {testError ? <div className="alert alert--error">{testError}</div> : null}
              {testLoading ? <div className="empty">Agent is aan het typen...</div> : null}
            </div>

            <div className="ai-test-controls">
              <select
                className="input ai-test-channel"
                value={testChannel}
                onChange={(event) => setTestChannel(event.target.value as "SMS" | "EMAIL")}
              >
                <option value="SMS">SMS</option>
                <option value="EMAIL">Email</option>
              </select>
              <button
                className="ai-test-system-toggle"
                onClick={() => setShowSystemPrompt((prev) => !prev)}
              >
                {showSystemPrompt ? "Verberg system prompt" : "Bekijk system prompt"}
              </button>
            </div>

            {showSystemPrompt ? (
              <div className="code-block">
                {testingAgent.systemPrompt || "Geen system prompt ingesteld."}
              </div>
            ) : null}

            <div className="ai-test-compose">
              <input
                className="input"
                placeholder="Typ een bericht om te testen..."
                value={testDraft}
                onChange={(event) => setTestDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!testLoading) runTest();
                  }
                }}
              />
              <button className="button ai-test-send" onClick={runTest} disabled={testLoading}>
                {testLoading ? "..." : "Verstuur"}
              </button>
            </div>

            {testMeta ? (
              <div className="alert alert--note ai-test-meta">
                {testMeta.eur !== undefined ? `Kosten: €${testMeta.eur.toFixed(6)}. ` : ""}
                {testMeta.model ? `Model: ${testMeta.model}. ` : ""}
                {testMeta.totalTokens !== undefined ? `Tokens: ${testMeta.totalTokens}. ` : ""}
                {testMeta.responseSpeed ? `Snelheid: ${testMeta.responseSpeed}. ` : ""}
                {testMeta.followUpLimitReached ? "Follow-up limiet bereikt. " : ""}
                {testMeta.handoffRequired
                  ? `Handoff vereist${testMeta.handoffReason ? `: ${testMeta.handoffReason}` : ""}. `
                  : ""}
                {testMeta.safetyFlags?.length ? `Flags: ${testMeta.safetyFlags.join(", ")}` : ""}
              </div>
            ) : (
              <div className="ai-test-footnote">Dit is een simulatie van agentgedrag.</div>
            )}
            <div className="modal__footer">
              <button className="button button--ghost" onClick={() => setTestingAgent(null)}>
                Sluiten
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default AiAgents;
