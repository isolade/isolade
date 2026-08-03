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
  // Whether this view already owns a turn lifecycle. Ownership also covers a
  // branch transition that deliberately keeps the provider activity UI idle.
  // In either case a second reader would fight that operation over shared state.
  active: boolean;
  // Whether the view already holds this message. The poll's copy of the row can
  // be a few seconds old, so a turn this view has just committed still shows up
  // as running; the committed message is the proof that it is not.
  holdsMessage: (messageId: string) => boolean;
}): string | null {
  const { inFlightMessageId, active, holdsMessage } = opts;
  if (!inFlightMessageId || active) return null;
  return holdsMessage(inFlightMessageId) ? null : inFlightMessageId;
}

// Synchronous ownership for the one logical turn a chat view may drive at a
// time. React state is intentionally not the lock: two submits, or hydration
// and reconciliation, can run before React publishes the first state update.
// A monotonically increasing lease also means cleanup from a detached reader
// cannot settle the replacement that took ownership while it was unwinding.
export type TurnLease = number;

export class TurnLifecycle {
  private nextLease = 0;
  private lease: TurnLease | null;

  constructor(active = false) {
    this.lease = active ? this.mint() : null;
  }

  get active(): boolean {
    return this.lease !== null;
  }

  get current(): TurnLease | null {
    return this.lease;
  }

  claim(): TurnLease | null {
    if (this.lease !== null) return null;
    this.lease = this.mint();
    return this.lease;
  }

  replace(): TurnLease {
    this.lease = this.mint();
    return this.lease;
  }

  owns(lease: TurnLease): boolean {
    return this.lease === lease;
  }

  release(lease: TurnLease): boolean {
    if (!this.owns(lease)) return false;
    this.lease = null;
    return true;
  }

  reset(): boolean {
    if (this.lease === null) return false;
    this.lease = null;
    return true;
  }

  private mint(): TurnLease {
    this.nextLease += 1;
    return this.nextLease;
  }
}
