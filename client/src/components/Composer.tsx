import React from "react";

type Props = {
  channel: "SMS" | "EMAIL";
  subject: string;
  body: string;
  contactInfo?: {
    name?: string;
    email?: string;
    phone?: string;
  } | null;
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
}) => {
  const renderCost = () => {
    if (!suggestMeta) return null;
    const { eur, usdToEurRate, model, totalTokens } = suggestMeta;
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
      <div className="alert alert--note">
        AI‑kosten (schatting): {eurText}. {metaLine}
      </div>
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
        {error ? <div className="alert alert--error">{error}</div> : null}
        {success ? <div className="alert alert--success">{success}</div> : null}
        {renderContact()}
        {renderCost()}
        <div className="field">
          <label>Channel</label>
          <div className="toggle-group">
            {(["SMS", "EMAIL"] as const).map((value) => (
              <button
                key={value}
                className={`toggle ${channel === value ? "toggle--active" : ""}`}
                onClick={() => onChannelChange(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
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
        <div className="field confirm">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={confirmChecked}
              onChange={(event) => onConfirmChange(event.target.checked)}
            />
            <span>Ik heb dit nagelezen</span>
          </label>
        </div>
        <div className="field-row">
          <button
            className="button button--ghost"
            onClick={onSuggest}
            disabled={suggesting}
          >
            {suggesting ? "Suggestie..." : "Auto-suggest (NL)"}
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
    </section>
  );
};

export default Composer;
