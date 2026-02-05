import React from "react";
import { Contact } from "../types";

type Props = {
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  results: Contact[];
  loading: boolean;
  error?: string;
  selectedContactId?: string;
  onSelect: (contact: Contact) => void;
};

const ContactSearch: React.FC<Props> = ({
  query,
  onQueryChange,
  onSearch,
  results,
  loading,
  error,
  selectedContactId,
  onSelect,
}) => {
  return (
    <section className="panel">
      <header className="panel__header">
        <h2>Contacten</h2>
        <p>Zoek op naam, e-mail of telefoon.</p>
      </header>
      <div className="panel__body">
        <div className="field-row">
          <input
            className="input"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Zoek..."
          />
          <button className="button" onClick={onSearch} disabled={loading}>
            {loading ? "Zoeken..." : "Search"}
          </button>
        </div>
        {error ? <div className="alert alert--error">{error}</div> : null}
        <div className="list">
          {results.length === 0 && !loading ? (
            <div className="empty">Geen contacten gevonden.</div>
          ) : null}
          {results.map((contact) => {
            const selected = contact.id === selectedContactId;
            return (
              <button
                key={contact.id}
                className={`list-item ${selected ? "list-item--active" : ""}`}
                onClick={() => onSelect(contact)}
              >
                <div className="list-item__title">
                  {contact.firstName || contact.lastName
                    ? `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim()
                    : contact.email || contact.phone || "Onbekende contact"}
                </div>
                <div className="list-item__meta">
                  {contact.email || contact.phone || ""}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default ContactSearch;
