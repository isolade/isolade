// Coordinates replaceable request families. Every invalidation aborts all
// outstanding fetches and advances a monotonic generation, so even a transport
// that resolves after abort cannot publish stale state.
export class RequestGeneration {
  private value = 0;
  private readonly controllers = new Set<AbortController>();

  get current(): number {
    return this.value;
  }

  invalidate(): number {
    this.value += 1;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    return this.value;
  }

  createController(): AbortController {
    const controller = new AbortController();
    this.controllers.add(controller);
    return controller;
  }

  release(controller: AbortController): void {
    this.controllers.delete(controller);
  }

  accepts(generation: number, controller: AbortController): boolean {
    return !controller.signal.aborted && generation === this.value;
  }
}
