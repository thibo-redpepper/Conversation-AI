import React from "react";
import { AiAgent } from "../types";

export type ComposerSuggestMode = "standard" | "agent";

type Props = {
  channel: "SMS" | "EMAIL";
  subject: string;
  body: string;
  contactInfo?: {
    name?: string;
    email?: string;
    phone?: string;
  } | null;
  agents?: AiAgent[];
  selectedAgentId?: string | null;
  onAgentChange?: (id: string | null) => void;
  suggestMode?: ComposerSuggestMode;
  onSuggestModeChange?: (mode: ComposerSuggestMode) => void;
  canSuggest?: boolean;
  onChannelChange: (channel: "SMS" | "EMAIL") => void;
  onSubjectChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onSuggest: () => void;
  onSend: () => void;
  confirmChecked: boolean;
  onConfirmChange: (checked: boolean) => void;
  sending: boolean;
  suggesting: boolean;
  error?: string;
  success?: string;
  canSend: boolean;
  suggestMeta?: {
    usd?: number;
    eur?: number;
    usdToEurRate?: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    handoffRequired?: boolean;
    handoffReason?: string;
    safetyFlags?: string[];
    followUpLimitReached?: boolean;
    responseSpeed?: string;
  } | null;
};

const Composer: React.FC<Props> = ({
  channel,
  subject,
  body,
  contactInfo,
  onChannelChange,
  onSubjectChange,
  onBodyChange,
  onSuggest,
  onSend,
  confirmChecked,
  onConfirmChange,
  sending,
  suggesting,
  error,
  success,
  canSend,
  suggestMeta,
  agents,
  selectedAgentId,
  onAgentChange,
  suggestMode = "standard",
  onSuggestModeChange,
  canSuggest = true,
}) => {
  const usingAgentSuggest = suggestMode === "agent";

  const renderCost = () => {
    if (!suggestMeta) return null;
    const {
      eur,
      usdToEurRate,
      model,
      totalTokens,
      handoffRequired,
      handoffReason,
      safetyFlags,
      responseSpeed,
      followUpLimitReached,
    } = suggestMeta;
    const eurText =
      typeof eur === "number"
        ? eur === 0
          ? "€<0.0001"
          : `€${eur.toFixed(6)}`
        : "€—";
    const metaLine = [
      model ? `model: ${model}` : null,
      typeof totalTokens === "number" ? `tokens: ${totalTokens}` : null,
      usdToEurRate ? `rate: ${usdToEurRate}` : null,
    ]
      .filter(Boolean)
      .join(" • ");

    return (
      <>
        <div className="alert alert--note">
          AI‑kosten (schatting): {eurText}. {metaLine}
          {responseSpeed ? ` • speed: ${responseSpeed}` : ""}
          {followUpLimitReached ? " • follow-up limiet bereikt" : ""}
        </div>
        {handoffRequired ? (
          <div className="alert alert--error">
            Human handoff aanbevolen{handoffReason ? `: ${handoffReason}` : "."}
            {safetyFlags?.length ? ` Flags: ${safetyFlags.join(", ")}` : ""}
          </div>
        ) : null}
      </>
    );
  };

  const renderContact = () => {
    if (!contactInfo) return null;
    const { name, email, phone } = contactInfo;
    const line = [name, email, phone].filter(Boolean).join(" • ");
    if (!line) return null;
    return <div className="contact-pill">Contact: {line}</div>;
  };

  return (
    <section className="panel panel--composer">
      <header className="panel__header">
        <h2>Composer</h2>
        <p>Schrijf een nieuwe reply.</p>
      </header>
      <div className="panel__body">
        <div className="composer-inner">
          {error ? <div className="alert alert--error">{error}</div> : null}
          {success ? <div className="alert alert--success">{success}</div> : null}
          {renderContact()}
          {renderCost()}
          <div className="composer-meta-grid">
            <div className="field">
              <label>Suggestie bron</label>
              <div className="toggle-group toggle-group--segmented">
                <button
                  type="button"
                  className={`toggle ${suggestMode === "standard" ? "toggle--active" : ""}`}
                  onClick={() => onSuggestModeChange?.("standard")}
                >
                  Standaard auto-suggest
                </button>
                <button
                  type="button"
                  className={`toggle ${suggestMode === "agent" ? "toggle--active" : ""}`}
                  onClick={() => onSuggestModeChange?.("agent")}
                >
                  AI Agent antwoord
                </button>
              </div>
              {usingAgentSuggest ? (
                <span className="field-help">
                  Eenmalige agent-respons: reacties van leads starten hierdoor geen agent-sessie.
                </span>
              ) : null}
            </div>
            <div className="field">
              <label>Channel</label>
              <div className="toggle-group toggle-group--segmented">
                {(["SMS", "EMAIL"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`toggle ${channel === value ? "toggle--active" : ""}`}
                    onClick={() => onChannelChange(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {usingAgentSuggest && agents && agents.length > 0 ? (
            <div className="field">
              <label>AI Agent</label>
              <select
                className="input"
                value={selectedAgentId ?? ""}
                onChange={(event) => onAgentChange?.(event.target.value || null)}
              >
                <option value="">Standaard</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} {agent.active === false ? "(inactief)" : ""}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {usingAgentSuggest && (!agents || agents.length === 0) ? (
            <div className="alert alert--note">
              Geen AI agents gevonden voor deze subaccount.
            </div>
          ) : null}
          {channel === "EMAIL" ? (
            <div className="field">
              <label>Subject</label>
              <input
                className="input"
                value={subject}
                onChange={(event) => onSubjectChange(event.target.value)}
                placeholder="Onderwerp"
              />
            </div>
          ) : null}
          <div className="field">
            <label>Bericht</label>
            <textarea
              className="textarea"
              value={body}
              onChange={(event) => onBodyChange(event.target.value)}
              placeholder="Schrijf je bericht..."
            />
          </div>
          <div className="field composer-confirm">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(event) => onConfirmChange(event.target.checked)}
              />
              <span>Ik heb dit nagelezen</span>
            </label>
          </div>
          <div className="field-row composer-actions">
            <button
              className="button button--ghost"
              onClick={onSuggest}
              disabled={suggesting || !canSuggest}
            >
              {suggesting
                ? "Suggestie..."
                : usingAgentSuggest
                ? "Agent antwoord voorstellen"
                : "Auto-suggest (NL)"}
            </button>
            <button
              className="button"
              onClick={onSend}
              disabled={!canSend || sending}
            >
              {sending ? "Versturen..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Composer;
