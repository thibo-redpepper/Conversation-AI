import React from "react";
import { Message, MessageFilter } from "../types";

type Props = {
  messages: Message[];
  loading: boolean;
  error?: string;
  filter: MessageFilter;
  onFilterChange: (filter: MessageFilter) => void;
  onLoadMore?: () => void;
  hasNextPage?: boolean;
};

const formatTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("nl-NL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const getTypeLabel = (value: string) => {
  const lower = value?.toLowerCase();
  if (lower?.includes("sms")) return "SMS";
  if (lower?.includes("email")) return "Email";
  return "Onbekend";
};

const ThreadView: React.FC<Props> = ({
  messages,
  loading,
  error,
  filter,
  onFilterChange,
  onLoadMore,
  hasNextPage,
}) => {
  return (
    <section className="panel panel--thread">
      <header className="panel__header">
        <h2>Thread</h2>
        <div className="toggle-group">
          {(["ALL", "TYPE_SMS", "TYPE_EMAIL"] as MessageFilter[]).map(
            (value) => (
              <button
                key={value}
                className={`toggle ${filter === value ? "toggle--active" : ""}`}
                onClick={() => onFilterChange(value)}
              >
                {value === "ALL" ? "Alles" : value === "TYPE_SMS" ? "SMS" : "Email"}
              </button>
            )
          )}
        </div>
      </header>
      <div className="panel__body">
        {error ? <div className="alert alert--error">{error}</div> : null}
        {hasNextPage && onLoadMore ? (
          <button className="button button--ghost" onClick={onLoadMore}>
            Laad oudere berichten
          </button>
        ) : null}
        <div className="thread">
          {loading ? <div className="empty">Berichten laden...</div> : null}
          {!loading && messages.length === 0 ? (
            <div className="empty">Geen berichten gevonden.</div>
          ) : null}
          {messages.map((message) => {
            const direction = message.direction?.toLowerCase().includes("in")
              ? "in"
              : "out";
            return (
              <div key={message.id} className={`thread__message ${direction}`}>
                <div className="thread__meta">
                  <span>{getTypeLabel(message.type)}</span>
                  <span>{formatTime(message.timestamp)}</span>
                </div>
                {message.subject ? (
                  <div className="thread__subject">{message.subject}</div>
                ) : null}
                <div className="thread__body">{message.body || "(leeg)"}</div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default ThreadView;
