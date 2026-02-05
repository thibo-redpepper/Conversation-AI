export type MessagesPaginationState = {
  nextPage: boolean;
  lastMessageId?: string;
};

export const getNextMessagesQuery = (
  state: MessagesPaginationState,
  limit: number
) => {
  if (!state.nextPage || !state.lastMessageId) {
    return null;
  }

  return {
    limit,
    lastMessageId: state.lastMessageId,
  };
};
