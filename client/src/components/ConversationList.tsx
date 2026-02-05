import React from "react";
import { Conversation } from "../types";

type Props = {
  conversations: Conversation[];
  loading: boolean;
  error?: string;
  selectedConversationId?: string;
  onSelect: (conversation: Conversation) => void;
  mode?: "contact" | "recent";
  inboundOnly: boolean;
  onToggleInbound: (value: boolean) => void;
};

const formatDate = (value?: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("nl-NL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const getChannelLabel = (channel?: string) => {
  if (!channel) return "Onbekend";
  if (channel.toLowerCase().includes("sms")) return "SMS";
  if (channel.toLowerCase().includes("email")) return "Email";
  return channel;
};

const ConversationList: React.FC<Props> = ({
  conversations,
  loading,
  error,
  selectedConversationId,
  onSelect,
  mode = "contact",
  inboundOnly,
  onToggleInbound,
}) => {
  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Gesprekken</h2>
        {mode === "contact" ? (
          <p>Kies een gesprek om de thread te laden.</p>
        ) : null}
        <div className="toggle-group">
          <button
            className={`toggle ${inboundOnly ? "toggle--active" : ""}`}
            onClick={() => onToggleInbound(true)}
          >
            Alleen klantreacties
          </button>
          <button
            className={`toggle ${!inboundOnly ? "toggle--active" : ""}`}
            onClick={() => onToggleInbound(false)}
          >
            Alles
          </button>
        </div>
      </header>
      <div className="panel__body">
        {error ? <div className="alert alert--error">{error}</div> : null}
        <div className="list">
          {loading ? <div className="empty">Laden...</div> : null}
          {!loading && conversations.length === 0 ? (
            <div className="empty">Geen gesprekken gevonden.</div>
          ) : null}
          {conversations.map((conversation) => {
            const selected = conversation.id === selectedConversationId;
            return (
              <button
                key={conversation.id}
                className={`list-item ${selected ? "list-item--active" : ""}`}
                onClick={() => onSelect(conversation)}
              >
                <div className="list-item__row">
                  <span className="badge">{getChannelLabel(conversation.channel)}</span>
                  {conversation.unreadCount ? (
                    <span className="badge badge--accent">
                      {conversation.unreadCount} nieuw
                    </span>
                  ) : null}
                </div>
                <div className="list-item__title">
                  {conversation.lastMessageBody || "(geen preview)"}
                </div>
                <div className="list-item__meta">
                  {formatDate(conversation.lastMessageDate)}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default ConversationList;
