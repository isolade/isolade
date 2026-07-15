import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { schema } from "./db";

// The PTY command for an instance's shell terminal. A single kind (bash) since
// the Claude CLI tab was removed. Kept as a function so the call sites and the
// preset command stay in one place.
export function terminalCommand(): string {
  return "/bin/bash";
}

export class TerminalManager {
  constructor(private db: Db) {}

  create(instanceId: string) {
    const id = randomUUID();
    this.db.insert(schema.terminals).values({ id, instanceId }).run();
    return this.get(id)!;
  }

  get(id: string) {
    return this.db.select().from(schema.terminals).where(eq(schema.terminals.id, id)).get();
  }

  list(instanceId: string) {
    return this.db
      .select()
      .from(schema.terminals)
      .where(eq(schema.terminals.instanceId, instanceId))
      .all();
  }

  listAll() {
    return this.db.select().from(schema.terminals).all();
  }

  remove(id: string) {
    this.db.delete(schema.terminals).where(eq(schema.terminals.id, id)).run();
  }

  removeForInstance(instanceId: string) {
    this.db.delete(schema.terminals).where(eq(schema.terminals.instanceId, instanceId)).run();
  }
}
