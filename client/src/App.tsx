import React, { useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import ContactSearch from "./components/ContactSearch";
import ConversationList from "./components/ConversationList";
import ThreadView from "./components/ThreadView";
import Composer from "./components/Composer";
import { Contact, Conversation, Message, MessageFilter } from "./types";

const apiRequest = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });

  const data = await response
    .json()
    .catch(() => ({ error: "Onverwachte response." }));

  if (!response.ok) {
    const message = data?.error || "Er ging iets mis.";
    throw new Error(message);
  }

  return data as T;
};

const sortMessages = (items: Message[]) => {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.timestamp ?? "") || 0;
    const bTime = Date.parse(b.timestamp ?? "") || 0;
    return aTime - bTime;
  });
};

const App: React.FC = () => {
  const [query, setQuery] = useState("");
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<string | null>(null);
  const [selectedBrand, setSelectedBrand] = useState<"VastgoedMatch" | "TestAannemer">(
    "VastgoedMatch"
  );
  const [inboundOnly, setInboundOnly] = useState(true);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState<string | undefined>();
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [selectedContactInfo, setSelectedContactInfo] = useState<{
    name?: string;
    email?: string;
    phone?: string;
  } | null>(null);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsError, setConversationsError] = useState<string | undefined>();
  const [selectedConversation, setSelectedConversation] =
    useState<Conversation | null>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | undefined>();
  const [messageFilter, setMessageFilter] = useState<MessageFilter>("ALL");
  const [pagination, setPagination] = useState<{
    nextPage: boolean;
    lastMessageId?: string;
  }>({ nextPage: false });

  const [channel, setChannel] = useState<"SMS" | "EMAIL">("SMS");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | undefined>();
  const [sendSuccess, setSendSuccess] = useState<string | undefined>();

  const [suggesting, setSuggesting] = useState(false);
  const [suggestMeta, setSuggestMeta] = useState<{
    usd?: number;
    eur?: number;
    usdToEurRate?: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null>(null);

  const filteredMessages = useMemo(() => {
    if (messageFilter === "ALL") return messages;
    const needle = messageFilter === "TYPE_SMS" ? "sms" : "email";
    return messages.filter((message) =>
      message.type?.toLowerCase().includes(needle)
    );
  }, [messages, messageFilter]);

  const loadLocations = async () => {
    try {
      const data = await apiRequest<{ locations: { id: string; name: string }[] }>(
        "/api/locations"
      );
      setLocations(data.locations);
      if (data.locations.length > 0) {
        setSelectedLocationId((prev) => prev ?? data.locations[0].id);
      }
    } catch {
      setLocations([]);
    }
  };

  const loadRecentConversations = async (locationId: string) => {
    setConversationsLoading(true);
    setConversationsError(undefined);
    setConversations([]);
    setSelectedConversation(null);
    setMessages([]);
    setPagination({ nextPage: false });

    try {
      const data = await apiRequest<{ conversations: Conversation[] }>(
        `/api/conversations/recent?locationId=${locationId}&inboundOnly=${inboundOnly}`
      );
      setConversations(data.conversations);
    } catch (error) {
      setConversationsError(
        error instanceof Error ? error.message : "Fout bij laden."
      );
    } finally {
      setConversationsLoading(false);
    }
  };

  const handleSearch = async () => {
    setContactsLoading(true);
    setContactsError(undefined);
    setContacts([]);
    setSelectedContact(null);
    setSelectedContactInfo(null);
    setConversations([]);
    setSelectedConversation(null);
    setMessages([]);
    setPagination({ nextPage: false });

    try {
      const data = await apiRequest<{ contacts: Contact[] }>(
        "/api/contacts/search",
        {
          method: "POST",
          body: JSON.stringify({ query, locationId: selectedLocationId ?? undefined }),
        }
      );
      setContacts(data.contacts);
    } catch (error) {
      setContactsError(error instanceof Error ? error.message : "Fout bij zoeken.");
    } finally {
      setContactsLoading(false);
    }
  };

  const handleSelectContact = async (contact: Contact) => {
    setSelectedContact(contact);
    setSelectedContactInfo({
      name: `${contact.firstName ?? ""} ${contact.lastName ?? ""}`.trim(),
      email: contact.email,
      phone: contact.phone,
    });
    setConversationsLoading(true);
    setConversationsError(undefined);
    setConversations([]);
    setSelectedConversation(null);
    setMessages([]);
    setPagination({ nextPage: false });

    try {
      const data = await apiRequest<{ conversations: Conversation[] }>(
        `/api/contacts/${contact.id}/conversations?locationId=${
          selectedLocationId ?? ""
        }&inboundOnly=${inboundOnly}`
      );
      setConversations(data.conversations);
    } catch (error) {
      setConversationsError(
        error instanceof Error ? error.message : "Fout bij laden."
      );
    } finally {
      setConversationsLoading(false);
    }
  };

  const loadMessages = async (conversationId: string, lastMessageId?: string) => {
    setMessagesLoading(true);
    setMessagesError(undefined);

    try {
      const params = new URLSearchParams();
      params.set("limit", "20");
      if (lastMessageId) params.set("lastMessageId", lastMessageId);

      if (selectedLocationId) {
        params.set("locationId", selectedLocationId);
      }

      const data = await apiRequest<{
        messages: Message[];
        nextPage: boolean;
        lastMessageId?: string;
      }>(`/api/conversations/${conversationId}/messages?${params}`);

      setPagination({
        nextPage: data.nextPage,
        lastMessageId: data.lastMessageId,
      });

      setMessages((prev) => {
        const combined = lastMessageId
          ? [...data.messages, ...prev]
          : data.messages;
        const unique = new Map<string, Message>();
        combined.forEach((message) => unique.set(message.id, message));
        return sortMessages(Array.from(unique.values()));
      });
    } catch (error) {
      setMessagesError(
        error instanceof Error ? error.message : "Fout bij laden."
      );
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleSelectConversation = async (conversation: Conversation) => {
    setSelectedConversation(conversation);
    if (conversation.contactId && selectedLocationId) {
      try {
        const data = await apiRequest<{ contact: Contact }>(
          `/api/contacts/${conversation.contactId}?locationId=${selectedLocationId}`
        );
        setSelectedContact(data.contact);
        setSelectedContactInfo({
          name: `${data.contact.firstName ?? ""} ${data.contact.lastName ?? ""}`.trim(),
          email: data.contact.email,
          phone: data.contact.phone,
        });
      } catch {
        setSelectedContact({ id: conversation.contactId });
        setSelectedContactInfo(null);
      }
    }
    setMessages([]);
    setPagination({ nextPage: false });
    await loadMessages(conversation.id);
  };

  const handleLoadOlder = async () => {
    if (!selectedConversation || !pagination.nextPage || !pagination.lastMessageId) {
      return;
    }
    await loadMessages(selectedConversation.id, pagination.lastMessageId);
  };

  const handleSuggest = async () => {
    if (!selectedConversation || !selectedContact || !selectedLocationId) {
      setSendError("Selecteer eerst een contact en gesprek.");
      return;
    }

    setSuggesting(true);
    setSendError(undefined);

    try {
      const data = await apiRequest<{
        suggestion: {
          text: string;
          usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
          cost?: {
            usd?: number;
            eur?: number;
            usdToEurRate?: number;
            model?: string;
          };
        };
      }>("/api/suggest", {
        method: "POST",
        body: JSON.stringify({
          conversationId: selectedConversation.id,
          contactId: selectedContact.id,
          locationId: selectedLocationId,
        }),
      });
      setBody(data.suggestion.text);
      if (data.suggestion.cost || data.suggestion.usage) {
        setSuggestMeta({
          usd: data.suggestion.cost?.usd,
          eur: data.suggestion.cost?.eur,
          usdToEurRate: data.suggestion.cost?.usdToEurRate,
          model: data.suggestion.cost?.model,
          inputTokens: data.suggestion.usage?.inputTokens,
          outputTokens: data.suggestion.usage?.outputTokens,
          totalTokens: data.suggestion.usage?.totalTokens,
        });
      } else {
        setSuggestMeta(null);
      }
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Fout bij suggestie."
      );
    } finally {
      setSuggesting(false);
    }
  };

  const handleSend = async () => {
    if (!selectedContact || !selectedLocationId) {
      setSendError("Selecteer eerst een contact.");
      return;
    }

    setSending(true);
    setSendError(undefined);
    setSendSuccess(undefined);

    try {
      const payload = {
        conversationId: selectedConversation?.id,
        contactId: selectedContact.id,
        channel,
        subject: channel === "EMAIL" ? subject : undefined,
        body,
        locationId: selectedLocationId,
      };

      const data = await apiRequest<{
        success: boolean;
        messageId?: string;
        emailMessageId?: string;
      }>("/api/conversations/messages", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      setSendSuccess(
        `Verzonden. messageId: ${data.messageId ?? "-"}` +
          (data.emailMessageId
            ? `, emailMessageId: ${data.emailMessageId}`
            : "")
      );
      setBody("");
      setSubject("");
      setConfirmChecked(false);
      setSuggestMeta(null);

      if (selectedConversation) {
        await loadMessages(selectedConversation.id);
      }
    } catch (error) {
      setSendError(
        error instanceof Error ? error.message : "Fout bij versturen."
      );
    } finally {
      setSending(false);
    }
  };

  const canSend =
    !!body.trim() &&
    confirmChecked &&
    (!!selectedContact || !!selectedConversation) &&
    (channel === "SMS" || (channel === "EMAIL" && !!subject.trim()));

  React.useEffect(() => {
    loadLocations();
  }, []);

  React.useEffect(() => {
    if (selectedLocationId) {
      setSelectedContact(null);
      setContacts([]);
      setQuery("");
      loadRecentConversations(selectedLocationId);
    }
  }, [selectedLocationId, inboundOnly]);

  const brandMap: Record<string, string[]> = {
    VastgoedMatch: ["Vastgoed"],
    TestAannemer: ["Dakwerken", "Gevelwerken"],
  };

  const filteredLocations = locations.filter((loc) =>
    (brandMap[selectedBrand] ?? []).includes(loc.name)
  );

  React.useEffect(() => {
    if (!selectedLocationId) {
      if (filteredLocations.length > 0) {
        setSelectedLocationId(filteredLocations[0].id);
      }
      return;
    }
    const exists = filteredLocations.some((loc) => loc.id === selectedLocationId);
    if (!exists) {
      setSelectedLocationId(filteredLocations[0]?.id ?? null);
    }
  }, [selectedBrand, locations, selectedLocationId, filteredLocations]);

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>Convo AI Hub</h1>
          <p>Multi-account inbox voor klantreacties met AI.</p>
        </div>
        <div className="header-actions">
          <NavLink
            className={({ isActive }) => `toggle ${isActive ? "toggle--active" : ""}`}
            to="/dashboard"
            end
          >
            Dashboard
          </NavLink>
          <NavLink
            className={({ isActive }) => `toggle ${isActive ? "toggle--active" : ""}`}
            to="/crm/pipedrive"
            end
          >
            CRM
          </NavLink>
        </div>
        <div className="location-select">
          <label>Merk</label>
          <select
            className="input"
            value={selectedBrand}
            onChange={(event) =>
              setSelectedBrand(event.target.value as "VastgoedMatch" | "TestAannemer")
            }
          >
            <option value="VastgoedMatch">VastgoedMatch</option>
            <option value="TestAannemer">TestAannemer</option>
          </select>
        </div>
        <div className="location-select">
          <label>Subaccount</label>
          <select
            className="input"
            value={selectedLocationId ?? ""}
            onChange={(event) => setSelectedLocationId(event.target.value)}
          >
            {filteredLocations.length === 0 ? (
              <option value="">Geen locaties</option>
            ) : null}
            {filteredLocations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <main className="app__grid">
        <ContactSearch
          query={query}
          onQueryChange={setQuery}
          onSearch={handleSearch}
          results={contacts}
          loading={contactsLoading}
          error={contactsError}
          selectedContactId={selectedContact?.id}
          onSelect={handleSelectContact}
        />

        <ConversationList
          conversations={conversations}
          loading={conversationsLoading}
          error={conversationsError}
          selectedConversationId={selectedConversation?.id}
          onSelect={handleSelectConversation}
          mode={selectedContact ? "contact" : "recent"}
          inboundOnly={inboundOnly}
          onToggleInbound={setInboundOnly}
        />

        <div className="panel-stack">
          <ThreadView
            messages={filteredMessages}
            loading={messagesLoading}
            error={messagesError}
            filter={messageFilter}
            onFilterChange={setMessageFilter}
            onLoadMore={handleLoadOlder}
            hasNextPage={pagination.nextPage}
          />
          <Composer
            channel={channel}
            subject={subject}
            body={body}
            contactInfo={selectedContactInfo}
            onChannelChange={setChannel}
            onSubjectChange={setSubject}
            onBodyChange={setBody}
            onSuggest={handleSuggest}
            onSend={handleSend}
            confirmChecked={confirmChecked}
            onConfirmChange={setConfirmChecked}
            sending={sending}
            suggesting={suggesting}
            error={sendError}
            success={sendSuccess}
            canSend={canSend}
            suggestMeta={suggestMeta}
          />
        </div>
      </main>
    </div>
  );
};

export default App;
