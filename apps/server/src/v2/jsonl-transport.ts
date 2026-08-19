import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonlTransport {
  send(message: unknown): void;
  onLine(listener: (line: string) => void): () => void;
  close(): void;
}

export class StreamJsonlTransport implements JsonlTransport {
  readonly #child: ChildProcess;
  readonly #events = new EventEmitter();

  constructor(child: ChildProcess) {
    this.#child = child;
    if (!child.stdout) throw new Error("provider stdout is required");
    const rl = createInterface({ input: child.stdout }) as unknown as EventEmitter;
    rl.on("line", (line: string) => {
      const trimmed = line.trim();
      if (trimmed) this.#events.emit("line", trimmed);
    });
    (child as unknown as EventEmitter).on("exit", () => this.#events.emit("close"));
  }

  send(message: unknown): void {
    if (!this.#child.stdin) throw new Error("provider stdin is required");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onLine(listener: (line: string) => void): () => void {
    this.#events.on("line", listener);
    return () => this.#events.off("line", listener);
  }

  close(): void {
    this.#child.stdin?.end();
  }
}

/** In-memory JSONL pair for protocol fixtures. */
export class MemoryJsonlPair {
  readonly client: JsonlTransport;
  readonly server: JsonlTransport;

  constructor() {
    const a = new EventEmitter();
    const b = new EventEmitter();
    this.client = {
      send: (message) => b.emit("line", JSON.stringify(message)),
      onLine: (listener) => {
        a.on("line", listener);
        return () => a.off("line", listener);
      },
      close: () => a.emit("close"),
    };
    this.server = {
      send: (message) => a.emit("line", JSON.stringify(message)),
      onLine: (listener) => {
        b.on("line", listener);
        return () => b.off("line", listener);
      },
      close: () => b.emit("close"),
    };
  }
}
