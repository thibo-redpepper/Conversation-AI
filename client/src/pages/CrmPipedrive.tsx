import React, { useMemo, useState, useEffect } from "react";

type Lead = {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  status: string;
  owner: string;
  createdAt: string;
  source?: string;
  pipelineStage?: string;
  last_inbound_at?: string | null;
  last_outbound_at?: string | null;
};

type AutoReplyRule = {
  id: string;
  name: string;
  prompt: string;
  channel: "email" | "sms" | "both";
  enabled: boolean;
  delay_minutes?: number;
  business_hours_only?: boolean;
  created_at?: string;
};

type Automation = {
  id: string;
  name: string;
  trigger_type?: string;
  trigger_value?: string | null;
  channel: "email" | "sms" | "both";
  email_subject?: string | null;
  email_body?: string | null;
  sms_body?: string | null;
  delay_minutes?: number | null;
  business_hours_only?: boolean | null;
  enabled: boolean;
  steps?: AutomationStep[] | null;
  created_at?: string;
};

type AutomationStepType = "trigger" | "wait" | "email" | "sms";

type AutomationStep = {
  id: string;
  type: AutomationStepType;
  config: Record<string, string | number | boolean | null | undefined>;
};

const initialLeads: Lead[] = [];

const createStepId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `step_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("nl-NL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const CrmPipedrive: React.FC = () => {
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [crmTab, setCrmTab] = useState<"inbox" | "settings">("inbox");
  const [settingsView, setSettingsView] = useState<"rules" | "automations">("rules");
  const [leadStatus, setLeadStatus] = useState<"all" | "open" | "replied">("open");
  const [leadQuery, setLeadQuery] = useState("");
  const [leadLoading, setLeadLoading] = useState(false);
  const [leadError, setLeadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subject, setSubject] = useState("Follow-up");
  const [channel, setChannel] = useState<"email" | "sms">("email");
  const [body, setBody] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [autoSuggesting, setAutoSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [aiMeta, setAiMeta] = useState<{ costEur?: number; tokens?: number; model?: string } | null>(null);
  const [threadMessages, setThreadMessages] = useState<
    {
      id: string;
      direction: "inbound" | "outbound";
      subject?: string;
      body?: string;
      timestamp?: string;
      from_email?: string;
      to_email?: string;
    }[]
  >([]);
  const [infoLeadId, setInfoLeadId] = useState<string | null>(null);
  const [editLeadId, setEditLeadId] = useState<string | null>(null);
  const [editLead, setEditLead] = useState({
    name: "",
    email: "",
    phone: "",
    status: "",
    owner: "",
    source: "",
    pipelineStage: "",
  });
  const [newLead, setNewLead] = useState({
    name: "",
    email: "",
    phone: "",
  });
  const [rules, setRules] = useState<AutoReplyRule[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [automationsLoading, setAutomationsLoading] = useState(false);
  const [automationsError, setAutomationsError] = useState<string | null>(null);
  const [automationForm, setAutomationForm] = useState({
    id: "",
    name: "",
    businessHoursOnly: false,
    enabled: true,
    steps: [] as AutomationStep[],
  });
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [ruleForm, setRuleForm] = useState({
    id: "",
    name: "",
    prompt: "",
    channel: "both" as "email" | "sms" | "both",
    delayMinutes: "0",
    businessHoursOnly: false,
    enabled: true,
  });

  const fetchLeads = async () => {
    setLeadLoading(true);
    setLeadError(null);
    try {
      const params = new URLSearchParams();
      params.set("status", leadStatus);
      if (leadQuery.trim()) params.set("q", leadQuery.trim());
      params.set("limit", "100");
      const response = await fetch(`/api/crm/leads?${params.toString()}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Leads ophalen mislukt.");
      }
      const nextLeads = data.data ?? [];
      setLeads(nextLeads);
      if (nextLeads.length > 0) {
        setSelectedId((prev) => prev ?? nextLeads[0].id);
      } else {
        setSelectedId(null);
      }
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Leads ophalen mislukt.");
    } finally {
      setLeadLoading(false);
    }
  };

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedId) ?? null,
    [leads, selectedId]
  );

  useEffect(() => {
    fetchLeads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadStatus]);

  useEffect(() => {
    if (crmTab === "settings") {
      fetchRules();
      fetchAutomations();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crmTab]);

  useEffect(() => {
    if (
      crmTab === "settings" &&
      automationForm.steps.length === 0 &&
      !automationForm.id &&
      !automationForm.name
    ) {
      resetAutomationForm();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crmTab]);

  useEffect(() => {
    loadThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const handleAddLead = () => {
    if (!newLead.name.trim()) return;
    const create = async () => {
      try {
        const response = await fetch("/api/crm/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newLead.name.trim(),
            email: newLead.email.trim() || undefined,
            phone: newLead.phone.trim() || undefined,
            status: "Test",
            owner: "Jij",
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data?.error || "Lead toevoegen mislukt.");
        }
        setNewLead({ name: "", email: "", phone: "" });
        await fetchLeads();
      } catch (error) {
        setLeadError(error instanceof Error ? error.message : "Lead toevoegen mislukt.");
      }
    };

    create();
  };

  const fetchRules = async () => {
    setRulesLoading(true);
    setRulesError(null);
    try {
      const response = await fetch("/api/crm/auto-reply-rules");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Regels ophalen mislukt.");
      }
      setRules(data.data ?? []);
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : "Regels ophalen mislukt.");
    } finally {
      setRulesLoading(false);
    }
  };

  const resetAutomationForm = () => {
    setAutomationForm({
      id: "",
      name: "",
      businessHoursOnly: false,
      enabled: true,
      steps: [
        {
          id: createStepId(),
          type: "trigger",
          config: { triggerType: "stage", triggerValue: "" },
        },
      ],
    });
  };

  const addAutomationStep = (type: AutomationStepType) => {
    setAutomationForm((prev) => {
      if (type === "trigger" && prev.steps.some((step) => step.type === "trigger")) {
        return prev;
      }
      const nextStep: AutomationStep = {
        id: createStepId(),
        type,
        config:
          type === "trigger"
            ? { triggerType: "stage", triggerValue: "" }
            : type === "wait"
            ? { minutes: 5 }
            : type === "email"
            ? { subject: "", body: "" }
            : { body: "" },
      };
      return { ...prev, steps: [...prev.steps, nextStep] };
    });
  };

  const updateAutomationStep = (stepId: string, patch: AutomationStep["config"]) => {
    setAutomationForm((prev) => ({
      ...prev,
      steps: prev.steps.map((step) =>
        step.id === stepId ? { ...step, config: { ...step.config, ...patch } } : step
      ),
    }));
  };

  const moveAutomationStep = (stepId: string, direction: -1 | 1) => {
    setAutomationForm((prev) => {
      const index = prev.steps.findIndex((step) => step.id === stepId);
      if (index < 0) return prev;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.steps.length) return prev;
      const nextSteps = [...prev.steps];
      const [removed] = nextSteps.splice(index, 1);
      nextSteps.splice(nextIndex, 0, removed);
      return { ...prev, steps: nextSteps };
    });
  };

  const removeAutomationStep = (stepId: string) => {
    setAutomationForm((prev) => ({
      ...prev,
      steps: prev.steps.filter((step) => step.id !== stepId),
    }));
  };

  const deriveStepsFromAutomation = (automation: Automation): AutomationStep[] => {
    if (automation.steps && automation.steps.length) {
      return automation.steps.map((step) => ({
        ...step,
        id: step.id || createStepId(),
      }));
    }
    const steps: AutomationStep[] = [
      {
        id: createStepId(),
        type: "trigger",
        config: {
          triggerType: automation.trigger_type ?? "stage",
          triggerValue: automation.trigger_value ?? "",
        },
      },
    ];
    if (automation.delay_minutes && automation.delay_minutes > 0) {
      steps.push({
        id: createStepId(),
        type: "wait",
        config: { minutes: automation.delay_minutes },
      });
    }
    if (automation.channel === "email" || automation.channel === "both") {
      steps.push({
        id: createStepId(),
        type: "email",
        config: {
          subject: automation.email_subject ?? "",
          body: automation.email_body ?? "",
        },
      });
    }
    if (automation.channel === "sms" || automation.channel === "both") {
      steps.push({
        id: createStepId(),
        type: "sms",
        config: {
          body: automation.sms_body ?? "",
        },
      });
    }
    return steps;
  };

  const summarizeAutomation = (steps: AutomationStep[]) => {
    const trigger = steps.find((step) => step.type === "trigger");
    const wait = steps.find((step) => step.type === "wait");
    const email = steps.find((step) => step.type === "email");
    const sms = steps.find((step) => step.type === "sms");
    const channel: Automation["channel"] = email && sms ? "both" : email ? "email" : "sms";
    return {
      triggerType: (trigger?.config.triggerType as string) ?? "stage",
      triggerValue: (trigger?.config.triggerValue as string) ?? null,
      delayMinutes: wait?.config.minutes ? Number(wait.config.minutes) : 0,
      emailSubject: (email?.config.subject as string) ?? null,
      emailBody: (email?.config.body as string) ?? null,
      smsBody: (sms?.config.body as string) ?? null,
      channel,
    };
  };

  const fetchAutomations = async () => {
    setAutomationsLoading(true);
    setAutomationsError(null);
    try {
      const response = await fetch("/api/crm/automations");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Automations ophalen mislukt.");
      }
      setAutomations(data.data ?? []);
    } catch (error) {
      setAutomationsError(
        error instanceof Error ? error.message : "Automations ophalen mislukt."
      );
    } finally {
      setAutomationsLoading(false);
    }
  };

  const saveAutomation = async () => {
    if (!automationForm.name.trim()) {
      setAutomationsError("Geef een naam voor de automation.");
      return;
    }
    if (!automationForm.steps.length) {
      setAutomationsError("Voeg minstens één module toe.");
      return;
    }
    const trigger = automationForm.steps.find((step) => step.type === "trigger");
    if (!trigger) {
      setAutomationsError("Je automation moet starten met een trigger.");
      return;
    }
    const hasEmail = automationForm.steps.some((step) => step.type === "email");
    const hasSms = automationForm.steps.some((step) => step.type === "sms");
    if (!hasEmail && !hasSms) {
      setAutomationsError("Voeg minstens één Email of SMS module toe.");
      return;
    }
    const emailStep = automationForm.steps.find((step) => step.type === "email");
    if (emailStep && !String(emailStep.config.body || "").trim()) {
      setAutomationsError("Vul een e-mail body in.");
      return;
    }
    const smsStep = automationForm.steps.find((step) => step.type === "sms");
    if (smsStep && !String(smsStep.config.body || "").trim()) {
      setAutomationsError("Vul een SMS body in.");
      return;
    }
    const waitStep = automationForm.steps.find((step) => step.type === "wait");
    if (waitStep) {
      const minutes = Number(waitStep.config.minutes);
      if (!Number.isFinite(minutes) || minutes < 0) {
        setAutomationsError("Delay moet een positief getal zijn.");
        return;
      }
    }
    try {
      const summary = summarizeAutomation(automationForm.steps);
      const payload = {
        name: automationForm.name.trim(),
        triggerType: summary.triggerType,
        triggerValue: summary.triggerValue,
        channel: summary.channel,
        emailSubject: summary.emailSubject,
        emailBody: summary.emailBody,
        smsBody: summary.smsBody,
        delayMinutes: summary.delayMinutes,
        businessHoursOnly: automationForm.businessHoursOnly,
        enabled: automationForm.enabled,
        steps: automationForm.steps,
      };
      const response = await fetch(
        automationForm.id
          ? `/api/crm/automations/${automationForm.id}`
          : "/api/crm/automations",
        {
          method: automationForm.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Automation opslaan mislukt.");
      }
      resetAutomationForm();
      await fetchAutomations();
    } catch (error) {
      setAutomationsError(
        error instanceof Error ? error.message : "Automation opslaan mislukt."
      );
    }
  };

  const editAutomation = (automation: Automation) => {
    const steps = deriveStepsFromAutomation(automation);
    setAutomationForm({
      id: automation.id,
      name: automation.name,
      businessHoursOnly: automation.business_hours_only ?? false,
      enabled: automation.enabled,
      steps,
    });
  };

  const toggleAutomation = async (automation: Automation) => {
    try {
      const response = await fetch(`/api/crm/automations/${automation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !automation.enabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Automation bijwerken mislukt.");
      }
      await fetchAutomations();
    } catch (error) {
      setAutomationsError(
        error instanceof Error ? error.message : "Automation bijwerken mislukt."
      );
    }
  };

  const deleteAutomation = async (automationId: string) => {
    try {
      const response = await fetch(`/api/crm/automations/${automationId}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Automation verwijderen mislukt.");
      }
      await fetchAutomations();
    } catch (error) {
      setAutomationsError(
        error instanceof Error ? error.message : "Automation verwijderen mislukt."
      );
    }
  };

  const resetRuleForm = () => {
    setRuleForm({
      id: "",
      name: "",
      prompt: "",
      channel: "both",
      delayMinutes: "0",
      businessHoursOnly: false,
      enabled: true,
    });
  };

  const saveRule = async () => {
    if (!ruleForm.name.trim() || !ruleForm.prompt.trim()) {
      setRulesError("Geef een naam en regeltekst.");
      return;
    }
    try {
      const payload = {
        name: ruleForm.name.trim(),
        prompt: ruleForm.prompt.trim(),
        channel: ruleForm.channel,
        enabled: ruleForm.enabled,
        delayMinutes: Number(ruleForm.delayMinutes || 0),
        businessHoursOnly: ruleForm.businessHoursOnly,
      };
      const response = await fetch(
        ruleForm.id ? `/api/crm/auto-reply-rules/${ruleForm.id}` : "/api/crm/auto-reply-rules",
        {
          method: ruleForm.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Regel opslaan mislukt.");
      }
      resetRuleForm();
      await fetchRules();
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : "Regel opslaan mislukt.");
    }
  };

  const editRule = (rule: AutoReplyRule) => {
    setRuleForm({
      id: rule.id,
      name: rule.name,
      prompt: rule.prompt,
      channel: rule.channel,
      delayMinutes: String(rule.delay_minutes ?? 0),
      businessHoursOnly: rule.business_hours_only ?? false,
      enabled: rule.enabled,
    });
  };

  const toggleRule = async (rule: AutoReplyRule) => {
    try {
      const response = await fetch(`/api/crm/auto-reply-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Regel bijwerken mislukt.");
      }
      await fetchRules();
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : "Regel bijwerken mislukt.");
    }
  };

  const deleteRule = async (ruleId: string) => {
    try {
      const response = await fetch(`/api/crm/auto-reply-rules/${ruleId}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Regel verwijderen mislukt.");
      }
      await fetchRules();
    } catch (error) {
      setRulesError(error instanceof Error ? error.message : "Regel verwijderen mislukt.");
    }
  };

  const startEditLead = (lead: Lead) => {
    setEditLeadId(lead.id);
    setEditLead({
      name: lead.name ?? "",
      email: lead.email ?? "",
      phone: lead.phone ?? "",
      status: lead.status ?? "",
      owner: lead.owner ?? "",
      source: lead.source ?? "",
      pipelineStage: lead.pipelineStage ?? "",
    });
  };

  const cancelEditLead = () => {
    setEditLeadId(null);
  };

  const saveEditLead = async () => {
    if (!editLeadId) return;
    try {
      const response = await fetch(`/api/crm/leads/${editLeadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editLead.name.trim(),
          email: editLead.email.trim() || null,
          phone: editLead.phone.trim() || null,
          status: editLead.status.trim() || null,
          owner: editLead.owner.trim() || null,
          source: editLead.source.trim() || null,
          pipelineStage: editLead.pipelineStage.trim() || null,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Lead bijwerken mislukt.");
      }
      setEditLeadId(null);
      await fetchLeads();
    } catch (error) {
      setLeadError(error instanceof Error ? error.message : "Lead bijwerken mislukt.");
    }
  };

  const handleSend = () => {
    if (!selectedLead) {
      setSent("Selecteer een lead.");
      return;
    }

    if (channel === "email") {
      if (!selectedLead.email || !body.trim()) {
        setSent("Vul een bericht in en selecteer een lead met e-mail.");
        return;
      }
    } else {
      if (!selectedLead.phone || !body.trim()) {
        setSent("Vul een bericht in en selecteer een lead met telefoon.");
        return;
      }
    }

    const send = async () => {
      try {
        const response = await fetch(channel === "email" ? "/api/mailgun/send" : "/api/twilio/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            channel === "email"
              ? { to: selectedLead.email, subject, text: body }
              : { to: selectedLead.phone, body }
          ),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data?.error || "Verzenden mislukt.");
        }
        setSent(
          channel === "email"
            ? `E-mail verzonden naar ${selectedLead.email}.`
            : `SMS verzonden naar ${selectedLead.phone}.`
        );
        setBody("");
        await loadThread();
      } catch (error) {
        setSent(error instanceof Error ? error.message : "Verzenden mislukt.");
      }
    };

    send();
  };


  const handleAutoSuggest = async () => {
    if (!selectedLead) {
      setSuggestError("Selecteer eerst een lead.");
      return;
    }
    setAutoSuggesting(true);
    setSuggestError(null);
    try {
      const response = await fetch("/api/mailgun/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead: selectedLead,
          email: selectedLead.email || undefined,
          channel,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Auto-suggest mislukt.");
      }
      if (data?.text) {
        setBody(data.text);
      }
      setAiMeta({
        costEur: data?.cost?.eur,
        tokens: data?.usage?.totalTokens,
        model: data?.cost?.model,
      });
    } catch (error) {
      setSuggestError(error instanceof Error ? error.message : "Auto-suggest mislukt.");
    } finally {
      setAutoSuggesting(false);
    }
  };

  const loadThread = async () => {
    if (!selectedLead?.email && !selectedLead?.phone) return;
    const params = new URLSearchParams();
    if (selectedLead?.email) params.set("email", selectedLead.email);
    if (selectedLead?.phone) params.set("phone", selectedLead.phone);
    const response = await fetch(`/api/mailgun/thread?${params.toString()}`);
    const data = await response.json().catch(() => ({}));
    setThreadMessages(data.data ?? []);
  };

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>CRM omgeving</h1>
          <p>Leads, gesprek en antwoorden via e-mail — met openstaande follow-ups.</p>
        </div>
        <div className="crm-tabs">
          <button
            className={`toggle ${crmTab === "inbox" ? "toggle--active" : ""}`}
            onClick={() => setCrmTab("inbox")}
          >
            Inbox
          </button>
          <button
            className={`toggle ${crmTab === "settings" ? "toggle--active" : ""}`}
            onClick={() => setCrmTab("settings")}
          >
            Settings
          </button>
        </div>
        <div className="header-actions">
          <a className="toggle" href="/">
            Terug naar inbox
          </a>
        </div>
      </header>

      {crmTab === "settings" ? (
        <main className="crm-settings">
          <div className="settings-toolbar">
            <div>
              <h2>Settings</h2>
              <p>Kies welke configuratie je wilt beheren.</p>
            </div>
            <label className="settings-select">
              <span>Instellingen</span>
              <select
                className="input"
                value={settingsView}
                onChange={(event) =>
                  setSettingsView(event.target.value as "rules" | "automations")
                }
              >
                <option value="rules">Auto-reply regels</option>
                <option value="automations">Automations</option>
              </select>
            </label>
          </div>
          {settingsView === "rules" ? (
          <section className="panel crm-rules">
            <header className="panel__header">
              <div className="panel__title-row">
                <div>
                  <h2>Auto-reply regels</h2>
                  <p>Extra instructies voor de AI.</p>
                </div>
                <button className="button button--ghost" onClick={fetchRules}>
                  Refresh
                </button>
              </div>
            </header>
            <div className="panel__body">
              {rulesError ? <div className="alert alert--error">{rulesError}</div> : null}
              {rulesLoading ? <div className="alert alert--note">Regels laden...</div> : null}
              <div className="field">
                <label>Naam</label>
                <input
                  className="input"
                  value={ruleForm.name}
                  onChange={(event) =>
                    setRuleForm((prev) => ({ ...prev, name: event.target.value }))
                  }
                  placeholder="Bijv. Bellen voorstellen"
                />
              </div>
              <div className="field">
                <label>Regeltekst</label>
                <textarea
                  className="textarea"
                  value={ruleForm.prompt}
                  onChange={(event) =>
                    setRuleForm((prev) => ({ ...prev, prompt: event.target.value }))
                  }
                  placeholder="Bijv. Als klant beltijden noemt, bevestig het tijdstip en stel geen nieuwe timingvraag."
                />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Kanaal</label>
                  <select
                    className="input"
                    value={ruleForm.channel}
                    onChange={(event) =>
                      setRuleForm((prev) => ({
                        ...prev,
                        channel: event.target.value as "email" | "sms" | "both",
                      }))
                    }
                  >
                    <option value="both">Email + SMS</option>
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                  </select>
                </div>
                <div className="field">
                  <label>Delay (min)</label>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={ruleForm.delayMinutes}
                    onChange={(event) =>
                      setRuleForm((prev) => ({ ...prev, delayMinutes: event.target.value }))
                    }
                  />
                </div>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ruleForm.businessHoursOnly}
                  onChange={(event) =>
                    setRuleForm((prev) => ({
                      ...prev,
                      businessHoursOnly: event.target.checked,
                    }))
                  }
                />
                Alleen kantooruren toepassen
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={ruleForm.enabled}
                  onChange={(event) =>
                    setRuleForm((prev) => ({ ...prev, enabled: event.target.checked }))
                  }
                />
                Regel actief
              </label>
              <div className="button-row">
                {ruleForm.id ? (
                  <button className="button button--ghost" onClick={resetRuleForm}>
                    Nieuwe regel
                  </button>
                ) : null}
                <button className="button" onClick={saveRule}>
                  {ruleForm.id ? "Update regel" : "Regel toevoegen"}
                </button>
              </div>

              <div className="list">
                {rules.map((rule) => (
                  <div key={rule.id} className="rule-card">
                    <div className="rule-card__header">
                      <div>
                        <div className="rule-card__title">{rule.name}</div>
                        <div className="rule-card__meta">
                          {rule.channel.toUpperCase()} • delay {rule.delay_minutes ?? 0}m
                          {rule.business_hours_only ? " • kantooruren" : ""}
                        </div>
                      </div>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={() => toggleRule(rule)}
                        />
                        <span className="switch__track">
                          <span className="switch__thumb" />
                        </span>
                        <span className="switch__label">
                          {rule.enabled ? "Actief" : "Uit"}
                        </span>
                      </label>
                    </div>
                    <div className="rule-card__body">{rule.prompt}</div>
                    <div className="rule-card__actions">
                      <button className="button button--ghost" onClick={() => editRule(rule)}>
                        Bewerk
                      </button>
                      <button
                        className="button button--ghost"
                        onClick={() => deleteRule(rule.id)}
                      >
                        Verwijder
                      </button>
                    </div>
                  </div>
                ))}
                {rules.length === 0 && !rulesLoading ? (
                  <div className="empty">Nog geen regels.</div>
                ) : null}
              </div>
            </div>
          </section>
          ) : null}

        {settingsView === "automations" ? (
        <section className="panel crm-automations">
          <header className="panel__header">
            <div className="panel__title-row">
              <div>
                <h2>Automations</h2>
                <p>Drafts die later automatisch verstuurd worden.</p>
                </div>
                <button className="button button--ghost" onClick={fetchAutomations}>
                  Refresh
                </button>
              </div>
          </header>
          <div className="panel__body">
            {automationsError ? (
              <div className="alert alert--error">{automationsError}</div>
            ) : null}
            {automationsLoading ? (
              <div className="alert alert--note">Automations laden...</div>
            ) : null}
            <div className="automation-builder">
              <div className="automation-canvas">
                {automations.length === 0 && !automationsLoading ? (
                  <div className="empty">Nog geen automations.</div>
                ) : null}
                {automations.map((automation) => {
                  const steps = deriveStepsFromAutomation(automation);
                  return (
                    <div key={automation.id} className="automation-flow">
                      <div className="automation-flow__header">
                        <div>
                          <div className="automation-flow__title">{automation.name}</div>
                          <div className="automation-flow__meta">
                            {steps.find((step) => step.type === "trigger")
                              ? `Trigger ${String(
                                  steps.find((step) => step.type === "trigger")?.config.triggerType ??
                                    automation.trigger_type ??
                                    "stage"
                                )}${
                                  steps.find((step) => step.type === "trigger")?.config.triggerValue
                                    ? `: ${String(
                                        steps.find((step) => step.type === "trigger")?.config
                                          .triggerValue
                                      )}`
                                    : ""
                                }`
                              : "Geen trigger"}
                          </div>
                        </div>
                        <div className="automation-flow__actions">
                          <label className="switch">
                            <input
                              type="checkbox"
                              checked={automation.enabled}
                              onChange={() => toggleAutomation(automation)}
                            />
                            <span className="switch__track">
                              <span className="switch__thumb" />
                            </span>
                            <span className="switch__label">
                              {automation.enabled ? "Actief" : "Uit"}
                            </span>
                          </label>
                          <button
                            className="button button--ghost"
                            onClick={() => editAutomation(automation)}
                          >
                            Bewerk
                          </button>
                          <button
                            className="button button--ghost"
                            onClick={() => deleteAutomation(automation.id)}
                          >
                            Verwijder
                          </button>
                        </div>
                      </div>
                      <div className="automation-flow__nodes">
                        {steps.map((step, index) => (
                          <React.Fragment key={step.id}>
                            <div
                              className={`automation-node automation-node--${step.type}`}
                            >
                              <div className="automation-node__label">
                                {step.type === "trigger"
                                  ? "Trigger"
                                  : step.type === "wait"
                                  ? "Wacht"
                                  : step.type === "email"
                                  ? "Email"
                                  : "SMS"}
                              </div>
                              <div className="automation-node__title">
                                {step.type === "trigger"
                                  ? String(step.config.triggerType ?? "stage")
                                  : step.type === "wait"
                                  ? `${step.config.minutes ?? 0} min`
                                  : step.type === "email"
                                  ? String(step.config.subject ?? "E-mail sturen")
                                  : "SMS sturen"}
                              </div>
                              <div className="automation-node__text">
                                {step.type === "trigger"
                                  ? String(step.config.triggerValue ?? "—")
                                  : step.type === "wait"
                                  ? automation.business_hours_only
                                    ? "kantooruren"
                                    : "altijd"
                                  : step.type === "email"
                                  ? String(step.config.body ?? "").slice(0, 80) || "Template ontbreekt"
                                  : String(step.config.body ?? "").slice(0, 80) || "Template ontbreekt"}
                              </div>
                            </div>
                            {index < steps.length - 1 ? (
                              <div className="automation-connector" />
                            ) : null}
                          </React.Fragment>
                        ))}
                      </div>
                    </div>
                  );
                })}
                <button className="automation-add" onClick={resetAutomationForm}>
                  + Nieuwe automation
                </button>
              </div>
              <div className="automation-config">
                <div className="field">
                  <label>Naam</label>
                  <input
                    className="input"
                    value={automationForm.name}
                    onChange={(event) =>
                      setAutomationForm((prev) => ({ ...prev, name: event.target.value }))
                    }
                    placeholder="Bijv. Voicemail stage follow-up"
                  />
                </div>
                <div className="module-stack">
                  {automationForm.steps.map((step, index) => (
                    <div
                      key={step.id}
                      className={`module-card module-card--${step.type}`}
                    >
                      <div className="module-card__header">
                        <div>
                          <div className="module-card__title">
                            {step.type === "trigger"
                              ? "Trigger"
                              : step.type === "wait"
                              ? "Wacht"
                              : step.type === "email"
                              ? "Email"
                              : "SMS"}
                          </div>
                          <div className="module-card__meta">Module {index + 1}</div>
                        </div>
                        <div className="module-card__actions">
                          <button
                            className="button button--ghost"
                            onClick={() => moveAutomationStep(step.id, -1)}
                            disabled={index === 0}
                          >
                            ↑
                          </button>
                          <button
                            className="button button--ghost"
                            onClick={() => moveAutomationStep(step.id, 1)}
                            disabled={index === automationForm.steps.length - 1}
                          >
                            ↓
                          </button>
                          <button
                            className="button button--ghost"
                            onClick={() => removeAutomationStep(step.id)}
                            disabled={step.type === "trigger" && automationForm.steps.length === 1}
                          >
                            Verwijder
                          </button>
                        </div>
                      </div>
                      {step.type === "trigger" ? (
                        <div className="field-row">
                          <div className="field">
                            <label>Trigger type</label>
                            <select
                              className="input"
                              value={String(step.config.triggerType ?? "stage")}
                              onChange={(event) =>
                                updateAutomationStep(step.id, {
                                  triggerType: event.target.value,
                                })
                              }
                            >
                              <option value="stage">CRM stage</option>
                              <option value="tag">Tag</option>
                              <option value="status">Status</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>Trigger waarde</label>
                            <input
                              className="input"
                              value={String(step.config.triggerValue ?? "")}
                              onChange={(event) =>
                                updateAutomationStep(step.id, {
                                  triggerValue: event.target.value,
                                })
                              }
                              placeholder="Bijv. voicemail 2"
                            />
                          </div>
                        </div>
                      ) : null}
                      {step.type === "wait" ? (
                        <div className="field-row">
                          <div className="field">
                            <label>Delay (min)</label>
                            <input
                              className="input"
                              type="number"
                              min={0}
                              value={Number(step.config.minutes ?? 0)}
                              onChange={(event) =>
                                updateAutomationStep(step.id, {
                                  minutes: Number(event.target.value || 0),
                                })
                              }
                            />
                          </div>
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={automationForm.businessHoursOnly}
                              onChange={(event) =>
                                setAutomationForm((prev) => ({
                                  ...prev,
                                  businessHoursOnly: event.target.checked,
                                }))
                              }
                            />
                            Alleen kantooruren
                          </label>
                        </div>
                      ) : null}
                      {step.type === "email" ? (
                        <>
                          <div className="field">
                            <label>Email subject</label>
                            <input
                              className="input"
                              value={String(step.config.subject ?? "")}
                              onChange={(event) =>
                                updateAutomationStep(step.id, {
                                  subject: event.target.value,
                                })
                              }
                              placeholder="Onderwerp voor e-mail"
                            />
                          </div>
                          <div className="field">
                            <label>Email body</label>
                            <textarea
                              className="textarea"
                              value={String(step.config.body ?? "")}
                              onChange={(event) =>
                                updateAutomationStep(step.id, {
                                  body: event.target.value,
                                })
                              }
                              placeholder="E-mail template"
                            />
                          </div>
                        </>
                      ) : null}
                      {step.type === "sms" ? (
                        <div className="field">
                          <label>SMS body</label>
                          <textarea
                            className="textarea"
                            value={String(step.config.body ?? "")}
                            onChange={(event) =>
                              updateAutomationStep(step.id, {
                                body: event.target.value,
                              })
                            }
                            placeholder="SMS template"
                          />
                        </div>
                      ) : null}
                    </div>
                  ))}
                  <div className="module-add">
                    <button
                      className="button button--ghost"
                      onClick={() => addAutomationStep("trigger")}
                      disabled={automationForm.steps.some((step) => step.type === "trigger")}
                    >
                      + Trigger
                    </button>
                    <button className="button button--ghost" onClick={() => addAutomationStep("wait")}>
                      + Wacht
                    </button>
                    <button className="button button--ghost" onClick={() => addAutomationStep("email")}>
                      + Email
                    </button>
                    <button className="button button--ghost" onClick={() => addAutomationStep("sms")}>
                      + SMS
                    </button>
                  </div>
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={automationForm.enabled}
                    onChange={(event) =>
                      setAutomationForm((prev) => ({ ...prev, enabled: event.target.checked }))
                    }
                  />
                  Automation actief
                </label>
                <div className="button-row">
                  {automationForm.id ? (
                    <button className="button button--ghost" onClick={resetAutomationForm}>
                      Nieuwe automation
                    </button>
                  ) : null}
                  <button className="button" onClick={saveAutomation}>
                    {automationForm.id ? "Update automation" : "Automation toevoegen"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
        ) : null}
        </main>
      ) : (
        <main className="crm-layout">
        <div className="crm-left">
          <section className="panel crm-leads">
            <header className="panel__header">
              <div className="panel__title-row">
                <div>
                  <h2>Leads</h2>
                  <p>Openstaande replies eerst.</p>
                </div>
              <div className="toggle-row">
                <button
                  className={`toggle ${leadStatus === "open" ? "toggle--active" : ""}`}
                  onClick={() => setLeadStatus("open")}
                >
                  Openstaand
                </button>
                <button
                  className={`toggle ${leadStatus === "all" ? "toggle--active" : ""}`}
                  onClick={() => setLeadStatus("all")}
                >
                  Alles
                </button>
                <button
                  className={`toggle ${leadStatus === "replied" ? "toggle--active" : ""}`}
                  onClick={() => setLeadStatus("replied")}
                >
                  Beantwoord
                </button>
              </div>
            </div>
          </header>
          <div className="panel__body">
            <div className="field">
              <label>Zoek lead</label>
              <div className="field-row">
                <input
                  className="input"
                  placeholder="Naam, e-mail of telefoon"
                  value={leadQuery}
                  onChange={(event) => setLeadQuery(event.target.value)}
                />
                <button className="button button--ghost" onClick={fetchLeads}>
                  Zoek
                </button>
              </div>
            </div>
            <div className="field">
              <label>Test lead toevoegen</label>
              <div className="field-row">
                <input
                  className="input"
                  placeholder="Naam"
                  value={newLead.name}
                  onChange={(event) =>
                    setNewLead((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
                <input
                  className="input"
                  placeholder="E-mail"
                  value={newLead.email}
                  onChange={(event) =>
                    setNewLead((prev) => ({ ...prev, email: event.target.value }))
                  }
                />
                <input
                  className="input"
                  placeholder="Telefoon"
                  value={newLead.phone}
                  onChange={(event) =>
                    setNewLead((prev) => ({ ...prev, phone: event.target.value }))
                  }
                />
                <button className="button" onClick={handleAddLead}>
                  Voeg toe
                </button>
              </div>
            </div>
            {leadError ? <div className="alert alert--error">{leadError}</div> : null}
            {leadLoading ? <div className="alert alert--note">Leads laden...</div> : null}
            <div className="list">
              {leads.map((lead) => (
                <div
                  key={lead.id}
                  className={`lead-row ${lead.id === selectedId ? "lead-row--active" : ""}`}
                >
                  <button
                    className="lead-row__main"
                    onClick={() => setSelectedId(lead.id)}
                  >
                    <div className="lead-row__title">{lead.name}</div>
                    <div className="lead-row__meta">
                      {lead.status} • {lead.owner}
                      {lead.last_outbound_at && (!lead.last_inbound_at || new Date(lead.last_inbound_at).getTime() < new Date(lead.last_outbound_at).getTime()) ? " • open" : ""}
                    </div>
                  </button>
                  <button
                    className="icon-button"
                    onClick={() =>
                      setInfoLeadId((prev) => (prev === lead.id ? null : lead.id))
                    }
                    aria-label="Lead info"
                  >
                    i
                  </button>
                </div>
              ))}
            </div>
            {leads.length === 0 && !leadLoading ? (
              <div className="empty">Geen leads gevonden.</div>
            ) : null}
            {infoLeadId ? (
              <div className="lead-info">
                {(() => {
                  const infoLead = leads.find((item) => item.id === infoLeadId);
                  if (!infoLead) return null;
                  const isEditing = editLeadId === infoLead.id;
                  return (
                    <div>
                      <div className="lead-info__actions">
                        {!isEditing ? (
                          <button className="button button--ghost" onClick={() => startEditLead(infoLead)}>
                            Bewerk
                          </button>
                        ) : (
                          <div className="button-row">
                            <button className="button button--ghost" onClick={cancelEditLead}>
                              Annuleer
                            </button>
                            <button className="button" onClick={saveEditLead}>
                              Opslaan
                            </button>
                          </div>
                        )}
                      </div>
                      {isEditing ? (
                        <div className="detail-grid detail-grid--compact">
                          <div>
                            <strong>Naam</strong>
                            <input
                              className="input"
                              value={editLead.name}
                              onChange={(event) =>
                                setEditLead((prev) => ({ ...prev, name: event.target.value }))
                              }
                            />
                          </div>
                          <div>
                            <strong>Email</strong>
                            <input
                              className="input"
                              value={editLead.email}
                              onChange={(event) =>
                                setEditLead((prev) => ({ ...prev, email: event.target.value }))
                              }
                            />
                          </div>
                          <div>
                            <strong>Telefoon</strong>
                            <input
                              className="input"
                              value={editLead.phone}
                              onChange={(event) =>
                                setEditLead((prev) => ({ ...prev, phone: event.target.value }))
                              }
                            />
                          </div>
                          <div>
                            <strong>Status</strong>
                            <input
                              className="input"
                              value={editLead.status}
                              onChange={(event) =>
                                setEditLead((prev) => ({ ...prev, status: event.target.value }))
                              }
                            />
                          </div>
                          <div>
                            <strong>Owner</strong>
                            <input
                              className="input"
                              value={editLead.owner}
                              onChange={(event) =>
                                setEditLead((prev) => ({ ...prev, owner: event.target.value }))
                              }
                            />
                          </div>
                          <div>
                            <strong>Bron</strong>
                            <input
                              className="input"
                              value={editLead.source}
                              onChange={(event) =>
                                setEditLead((prev) => ({ ...prev, source: event.target.value }))
                              }
                            />
                          </div>
                          <div>
                            <strong>Pipeline</strong>
                            <input
                              className="input"
                              value={editLead.pipelineStage}
                              onChange={(event) =>
                                setEditLead((prev) => ({
                                  ...prev,
                                  pipelineStage: event.target.value,
                                }))
                              }
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="detail-grid detail-grid--compact">
                          <div>
                            <strong>Naam</strong>
                            <div>{infoLead.name}</div>
                          </div>
                          <div>
                            <strong>Email</strong>
                            <div>{infoLead.email ?? "—"}</div>
                          </div>
                          <div>
                            <strong>Telefoon</strong>
                            <div>{infoLead.phone ?? "—"}</div>
                          </div>
                          <div>
                            <strong>Status</strong>
                            <div>{infoLead.status}</div>
                          </div>
                          <div>
                            <strong>Owner</strong>
                            <div>{infoLead.owner}</div>
                          </div>
                          <div>
                            <strong>Aangemaakt</strong>
                            <div>{formatDate(infoLead.createdAt)}</div>
                          </div>
                          {infoLead.source ? (
                            <div>
                              <strong>Bron</strong>
                              <div>{infoLead.source}</div>
                            </div>
                          ) : null}
                          {infoLead.pipelineStage ? (
                            <div>
                              <strong>Pipeline</strong>
                              <div>{infoLead.pipelineStage}</div>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            ) : null}
          </div>
        </section>
        </div>

        <div className="crm-right">
          <section className="panel panel--thread">
            <header className="panel__header">
              <h2>Gesprek</h2>
              <p>Alle e-mails en SMS via deze tool (outbound + replies).</p>
            </header>
            <div className="panel__body">
              <button className="button button--ghost" onClick={loadThread}>
                Refresh
              </button>
              <div className="thread">
                {threadMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`thread__message ${message.direction === "inbound" ? "in" : "out"}`}
                  >
                    <div className="thread__meta">
                      <span>{message.direction === "inbound" ? "IN" : "UIT"}</span>
                      <span>{message.timestamp ? formatDate(message.timestamp) : "—"}</span>
                    </div>
                    <div className="thread__subject">{message.subject ?? "(geen onderwerp)"}</div>
                    <div className="thread__body">{message.body || "(leeg)"}</div>
                  </div>
                ))}
                {threadMessages.length === 0 ? (
                  <div className="empty">Geen berichten gevonden.</div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="panel crm-composer">
            <header className="panel__header">
              <h2>Antwoord sturen</h2>
              <p>Kies e-mail of SMS voor de geselecteerde lead.</p>
            </header>
            <div className="panel__body">
              {sent ? <div className="alert alert--success">{sent}</div> : null}
              {suggestError ? <div className="alert alert--error">{suggestError}</div> : null}
              {aiMeta?.costEur !== undefined ? (
                <div className="alert alert--muted">
                  AI-kosten (schatting): €{aiMeta.costEur.toFixed(4)}
                  {aiMeta.model ? ` • model: ${aiMeta.model}` : ""}
                  {aiMeta.tokens ? ` • tokens: ${aiMeta.tokens}` : ""}
                </div>
              ) : null}
              <div className="field">
                <label>Channel</label>
                <div className="toggle-row">
                  <button
                    className={`toggle ${channel === "email" ? "toggle--active" : ""}`}
                    onClick={() => setChannel("email")}
                  >
                    Email
                  </button>
                  <button
                    className={`toggle ${channel === "sms" ? "toggle--active" : ""}`}
                    onClick={() => setChannel("sms")}
                  >
                    SMS
                  </button>
                </div>
              </div>
              {channel === "email" ? (
                <div className="field">
                  <label>Onderwerp</label>
                  <input
                    className="input"
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                  />
                </div>
              ) : null}
              <div className="field">
                <label>Bericht</label>
                <textarea
                  className="textarea"
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder={channel === "sms" ? "Schrijf je SMS..." : "Schrijf je e-mail..."}
                />
              </div>
              <div className="button-row">
                <button
                  className="button button--ghost"
                  onClick={handleAutoSuggest}
                  disabled={autoSuggesting}
                >
                  {autoSuggesting ? "Auto-suggest..." : "Auto-suggest (AI)"}
                </button>
                <button className="button" onClick={handleSend}>
                  Verstuur
                </button>
              </div>
            </div>
          </section>
        </div>
        </main>
      )}

    </div>
  );
};

export default CrmPipedrive;
