export type Contact = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  dateAdded?: string;
  pipelineStageName?: string;
  postalCode?: string;
  city?: string;
  source?: string;
};

export type Conversation = {
  id: string;
  contactId?: string;
  channel?: string;
  lastMessageDate?: string;
  unreadCount?: number;
  lastMessageBody?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  pipelineStageName?: string;
};

export type Message = {
  id: string;
  conversationId?: string;
  contactId?: string;
  type: string;
  direction: string;
  body: string;
  subject?: string;
  timestamp: string;
};
