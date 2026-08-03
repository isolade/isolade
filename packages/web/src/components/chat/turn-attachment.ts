// Which turn a chat view has to go and attach to.
//
// Not every turn is started by the view that shows the chat. The server promotes
// a queued message into a turn of its own the moment the previous one settles,
// and a turn outlives the stream that asked for it, so a view can end up with a
// settled composer while the agent is working. The chat row names the running
// turn (`inFlightMessageId`), which is the one fact always in hand: it rides the
// chat poll, so it arrives whether or not this view has any local trace of the
// turn.
export function unfollowedTurnId(opts: {
  // The running turn's assistant message id as of the last chat poll.
  inFlightMessageId: string | null | undefined;
  // Whether this view is already reading a turn's stream. A view that is
  // streaming is either on this turn or on its way off one, and in both cases a
  // second reader would fight the first over the live row.
  streaming: boolean;
  // Whether the view already holds this message. The poll's copy of the row can
  // be a few seconds old, so a turn this view has just committed still shows up
  // as running; the committed message is the proof that it is not.
  holdsMessage: (messageId: string) => boolean;
}): string | null {
  const { inFlightMessageId, streaming, holdsMessage } = opts;
  if (!inFlightMessageId || streaming) return null;
  return holdsMessage(inFlightMessageId) ? null : inFlightMessageId;
}
