import { afterEach, describe, expect, it } from "vite-plus/test";
import Fastify, { type FastifyInstance } from "fastify";
import type { V2Event, V2TargetStatus } from "../src/v2/contract.ts";
import type { RuntimeManager } from "../src/v2/manager.ts";
import { registerV2Routes } from "../src/v2/routes.ts";

const apps: FastifyInstance[] = [];
const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];

afterEach(async () => {
  for (const reader of readers.splice(0)) {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const TARGET = "fable";

function event(seq: number, target = TARGET): V2Event {
  return {
    seq,
    target,
    at: `2026-08-18T00:00:${String(seq).padStart(2, "0")}.000Z`,
    kind: "turn.item",
    data: { seq },
  };
}

/**
 * Deterministic stand-in for the runtime manager. It owns the durable log, the
 * subscriber set, and a hook that fires *inside* `eventsAfter`, so a test can
 * place an emission at any exact point of historical replay — including the
 * last instant before the stream goes live.
 */
class FakeEventManager {
  readonly log: V2Event[] = [];
  readonly listeners = new Set<(event: V2Event) => void>();
  /** Every change to the live subscriber count, in order. */
  readonly subscriberTimeline: number[] = [];
  installs = 0;
  pageCalls = 0;
  onPage?: (call: number) => void;

  onEvent(listener: (event: V2Event) => void): () => void {
    this.installs += 1;
    this.listeners.add(listener);
    this.subscriberTimeline.push(this.listeners.size);
    return () => {
      this.listeners.delete(listener);
      this.subscriberTimeline.push(this.listeners.size);
    };
  }

  /** Emit as the manager does: append durably, then notify subscribers. */
  emit(next: V2Event): void {
    this.log.push(next);
    this.#notify(next);
  }

  /** Emit to subscribers only — models an event already inside a fetched page. */
  emitAlreadyPaged(next: V2Event): void {
    this.#notify(next);
  }

  // A listener may unsubscribe while being notified (the overflow path does
  // exactly that), so iterate a snapshot rather than the live set.
  #notify(next: V2Event): void {
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) listener(next);
  }

  eventsAfter(target: string, after: number, limit = 1000): V2Event[] {
    this.pageCalls += 1;
    this.onPage?.(this.pageCalls);
    return this.log
      .filter((entry) => entry.target === target && entry.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  minEventSeq(target: string): number | null {
    const first = this.log.filter((entry) => entry.target === target).at(0);
    return first?.seq ?? null;
  }

  lastEventSeq(target: string): number {
    return this.log.filter((entry) => entry.target === target).at(-1)?.seq ?? 0;
  }

  status(target: string): V2TargetStatus {
    return { target, lastEventSeq: this.lastEventSeq(target) } as unknown as V2TargetStatus;
  }
}

interface Stream {
  frames: () => Array<{ event?: string; id?: string; data: unknown }>;
  waitForFrames: (count: number) => Promise<void>;
  waitForEnd: () => Promise<void>;
  ended: () => boolean;
}

async function openStream(
  manager: FakeEventManager,
  query: string,
  routeOptions: Partial<Parameters<typeof registerV2Routes>[1]> = {},
): Promise<Stream> {
  const app = Fastify();
  apps.push(app);
  registerV2Routes(app, {
    manager: manager as unknown as RuntimeManager,
    token: "secret",
    enabled: true,
    ...routeOptions,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/v2/targets/${TARGET}/events${query}`, {
    headers: { authorization: "Bearer secret" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body!.getReader();
  readers.push(reader);

  let buffer = "";
  let done = false;
  const parsed: Array<{ event?: string; id?: string; data: unknown }> = [];
  const pump = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        return;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame: { event?: string; id?: string; data: unknown } = { data: null };
        for (const line of raw.split("\n")) {
          if (line.startsWith("id: ")) frame.id = line.slice(4);
          else if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("data: ")) frame.data = JSON.parse(line.slice(6));
        }
        parsed.push(frame);
        split = buffer.indexOf("\n\n");
      }
    }
  })();
  void pump.catch(() => {
    done = true;
  });

  const settle = async (predicate: () => boolean) => {
    for (let i = 0; i < 400; i += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`stream condition not met; frames=${JSON.stringify(parsed)}`);
  };

  return {
    frames: () => parsed,
    waitForFrames: (count) => settle(() => parsed.length >= count),
    waitForEnd: () => settle(() => done),
    ended: () => done,
  };
}

function seqs(stream: Stream): number[] {
  return stream
    .frames()
    .filter((frame) => frame.event === undefined)
    .map((frame) => Number(frame.id));
}

describe("v2 event stream replay-to-live handoff", () => {
  it("keeps exactly one subscriber installed across the whole connection", async () => {
    const manager = new FakeEventManager();
    manager.emit(event(1));
    manager.emit(event(2));
    const stream = await openStream(manager, "?after=0");
    await stream.waitForFrames(2);
    manager.emit(event(3));
    await stream.waitForFrames(3);

    // The old shape subscribed, flushed, unsubscribed, then re-subscribed:
    // its timeline reached 0 between replay and live, which is the lost-event
    // window. One continuous subscription cannot have that window.
    expect(manager.installs).toBe(1);
    expect(manager.subscriberTimeline).toEqual([1]);
    expect(manager.listeners.size).toBe(1);
  });

  it("delivers an event emitted at the last instant of replay exactly once, in order", async () => {
    const manager = new FakeEventManager();
    manager.emit(event(1));
    manager.emit(event(2));
    // Fires from inside the final page read: the latest moment an event can
    // arrive while the stream is still replaying history.
    manager.onPage = (call) => {
      if (call === 1) manager.emit(event(3));
    };
    const stream = await openStream(manager, "?after=0");
    await stream.waitForFrames(3);
    manager.emit(event(4));
    await stream.waitForFrames(4);

    expect(seqs(stream)).toEqual([1, 2, 3, 4]);
    expect(manager.installs).toBe(1);
  });

  it("does not duplicate an event that is in both a page and the live buffer", async () => {
    const manager = new FakeEventManager();
    manager.emit(event(1));
    manager.emit(event(2));
    manager.onPage = (call) => {
      // Already durable and inside the page we are about to return, and also
      // announced to subscribers — the classic double-delivery case.
      if (call === 1) manager.emitAlreadyPaged(event(2));
    };
    const stream = await openStream(manager, "?after=0");
    await stream.waitForFrames(2);
    manager.emit(event(5));
    await stream.waitForFrames(3);

    expect(seqs(stream)).toEqual([1, 2, 5]);
  });

  it("honours the after cursor and never re-sends consumed events", async () => {
    const manager = new FakeEventManager();
    for (const seq of [1, 2, 3]) manager.emit(event(seq));
    const stream = await openStream(manager, "?after=2");
    await stream.waitForFrames(1);
    manager.emit(event(4));
    await stream.waitForFrames(2);
    expect(seqs(stream)).toEqual([3, 4]);
  });

  it("ignores events for other targets", async () => {
    const manager = new FakeEventManager();
    manager.emit(event(1));
    const stream = await openStream(manager, "?after=0");
    await stream.waitForFrames(1);
    manager.emit(event(2, "scribe"));
    manager.emit(event(3));
    await stream.waitForFrames(2);
    expect(seqs(stream)).toEqual([1, 3]);
  });
});

describe("v2 event stream backlog is bounded", () => {
  it("ends the stream with an explicit resnapshot requirement instead of buffering without limit", async () => {
    const manager = new FakeEventManager();
    manager.emit(event(1));
    // A slow replay: while the first page is being produced, the runtime keeps
    // emitting past the configured backlog limit.
    manager.onPage = (call) => {
      if (call !== 1) return;
      for (const seq of [2, 3, 4, 5, 6]) manager.emit(event(seq));
    };
    const stream = await openStream(manager, "?after=0", { eventBacklogLimit: 2 });
    await stream.waitForEnd();

    const overflow = stream.frames().find((frame) => frame.event === "overflow");
    expect(overflow, JSON.stringify(stream.frames())).toBeDefined();
    const data = overflow!.data as Record<string, unknown>;
    expect(data.reason).toBe("replay_backlog_overflow");
    expect(data.resnapshot).toBe(true);
    expect(data.backlogLimit).toBe(2);
    // The stream states exactly where it stopped being complete, so recovery
    // is a cursor decision rather than a guess.
    expect(typeof data.lastDeliveredSeq).toBe("number");
    expect(data.firstUndeliveredSeq).toBe(4);
    expect(stream.ended()).toBe(true);

    // Nothing was delivered twice or out of order before the cut.
    const delivered = seqs(stream);
    expect(delivered).toEqual([...delivered].sort((a, b) => a - b));
    expect(new Set(delivered).size).toBe(delivered.length);
    expect(Math.max(...delivered, 0)).toBe(data.lastDeliveredSeq);

    // The subscriber is gone: an overflowed stream stops consuming memory.
    expect(manager.listeners.size).toBe(0);
  });

  it("keeps a healthy stream under the limit open", async () => {
    const manager = new FakeEventManager();
    manager.emit(event(1));
    manager.onPage = (call) => {
      if (call === 1) manager.emit(event(2));
    };
    const stream = await openStream(manager, "?after=0", { eventBacklogLimit: 2 });
    await stream.waitForFrames(2);
    manager.emit(event(3));
    await stream.waitForFrames(3);
    expect(seqs(stream)).toEqual([1, 2, 3]);
    expect(stream.frames().some((frame) => frame.event === "overflow")).toBe(false);
    expect(stream.ended()).toBe(false);
  });
});
