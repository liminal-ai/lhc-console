import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import type { AgentRecord } from "./agent-registry.ts";
import { loadPhotonEnvFile } from "./env-file.ts";
import { GroupCatchUpStore, GroupCatchUpStoreError } from "./group-catch-up.ts";
import { InboundDedupeStore } from "./inbound-dedupe.ts";
import { cleanMentionText, compileMentionPatterns, matchesMention } from "./mention-patterns.ts";
import type { RelayQueue } from "./relay.ts";
import { renderRelayPrompt } from "./relay-prompt.ts";

const DEFAULT_SIDECAR_PATH =
  process.env.LHC_PHOTON_SIDECAR_PATH ??
  "/srv/work/hermes-agent/plugins/platforms/photon/sidecar/index.mjs";

interface SidecarBinding {
  baseUrl: string;
  token: string;
}

interface PhotonContent {
  type?: string;
  text?: string;
}

interface PhotonInboundEvent {
  messageId?: string | null;
  space?: {
    id?: string | null;
    type?: string | null;
    phone?: string | null;
  };
  sender?: { id?: string | null };
  content?: PhotonContent;
  timestamp?: string | null;
}

export interface PhotonConnectorOptions {
  agent: AgentRecord;
  consoleHome: string;
  queue: RelayQueue;
  sidecar?: SidecarBinding;
  sidecarPath?: string;
  fetchImpl?: typeof fetch;
  loadPhotonEnv?: (path: string) => Record<string, string>;
  onError?: (message: string) => void;
}

export class PhotonConnector {
  readonly agentId: string;
  readonly #agent: AgentRecord;
  readonly #queue: RelayQueue;
  readonly #sidecarPath: string;
  readonly #fetchImpl: typeof fetch;
  readonly #loadPhotonEnv: (path: string) => Record<string, string>;
  readonly #onError: (message: string) => void;
  readonly #owners: Set<string>;
  readonly #mentionPatterns: RegExp[];
  readonly #catchUp: GroupCatchUpStore;
  readonly #dedupe: InboundDedupeStore;
  readonly #photonEnvFile: string;
  readonly #injectedSidecar?: SidecarBinding;
  #sidecar?: SidecarBinding;
  #child: ChildProcess | null = null;
  #abort: AbortController | null = null;
  #inboundTask: Promise<void> | null = null;
  #processing: Promise<void> = Promise.resolve();
  #started = false;
  #stopped = false;

  constructor(options: PhotonConnectorOptions) {
    const photon = options.agent.channels.photon;
    if (!photon) {
      throw new Error(`agent ${options.agent.id} has no channels.photon configuration`);
    }
    this.#agent = options.agent;
    this.agentId = options.agent.id;
    this.#queue = options.queue;
    this.#sidecarPath = options.sidecarPath ?? DEFAULT_SIDECAR_PATH;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#loadPhotonEnv = options.loadPhotonEnv ?? loadPhotonEnvFile;
    this.#onError = options.onError ?? ((message) => console.error(message));
    this.#photonEnvFile = photon.envFile;
    this.#owners = new Set(options.agent.ownerSenderIds);
    this.#mentionPatterns = compileMentionPatterns(options.agent.mentionPatterns);
    const stateDir = join(options.consoleHome, "agents", options.agent.id);
    this.#catchUp = new GroupCatchUpStore(join(stateDir, "group-catch-up.sqlite"));
    this.#dedupe = new InboundDedupeStore(join(stateDir, "inbound-dedupe.sqlite"));
    this.#injectedSidecar = options.sidecar;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#sidecar = this.#injectedSidecar ?? (await this.#spawnSidecar());
    this.#abort = new AbortController();
    this.#inboundTask = this.#consumeInbound(this.#abort.signal);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#abort?.abort();
    if (this.#inboundTask) await this.#inboundTask.catch(() => undefined);
    if (this.#sidecar && !this.#injectedSidecar) {
      await this.#post(this.#sidecar, "/shutdown", {}).catch(() => undefined);
    }
    if (this.#child) {
      this.#child.stdin?.end();
      this.#child.kill("SIGTERM");
      this.#child = null;
    }
    await this.#processing.catch(() => undefined);
  }

  async send(spaceId: string, text: string): Promise<void> {
    const sidecar = this.#sidecar;
    if (!sidecar) throw new Error(`photon connector for ${this.agentId} is not running`);
    await this.#post(sidecar, "/send", { spaceId, text, format: "text" });
  }

  #schedule(task: () => Promise<void>): void {
    this.#processing = this.#processing.then(task).catch((error) => {
      this.#reportProcessingError(error);
    });
  }

  #reportProcessingError(error: unknown): void {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "unknown connector error";
    this.#onError(`[photon:${this.agentId}] ${scrubSecrets(message)}`);
  }

  async #consumeInbound(signal: AbortSignal): Promise<void> {
    const sidecar = this.#sidecar;
    if (!sidecar) return;
    while (!signal.aborted && !this.#stopped) {
      try {
        const response = await this.#fetchImpl(`${sidecar.baseUrl}/inbound`, {
          headers: { "X-Hermes-Sidecar-Token": sidecar.token },
          signal,
        });
        if (!response.ok || !response.body) {
          await sleep(250);
          continue;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted && !this.#stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
              const event = JSON.parse(line) as PhotonInboundEvent;
              this.#schedule(() => this.#handleEvent(event));
            }
            newline = buffer.indexOf("\n");
          }
        }
      } catch (error) {
        if (signal.aborted || this.#stopped) return;
        this.#reportProcessingError(error);
        await sleep(250);
      }
    }
  }

  async #handleEvent(event: PhotonInboundEvent): Promise<void> {
    if (this.#stopped) return;
    const contentType = event.content?.type;
    if (contentType === "reaction" || contentType === "poll" || contentType === "poll_option") {
      return;
    }
    const text = extractText(event.content);
    if (text === null) return;
    const spaceId = event.space?.id;
    const messageId = event.messageId;
    const senderId = event.sender?.id ?? null;
    const timestamp = event.timestamp ?? new Date().toISOString();
    if (!spaceId || !messageId) return;
    if (!this.#dedupe.claim(spaceId, messageId)) return;
    if ((event.space?.type ?? "dm") === "group") {
      await this.#handleGroup({
        spaceId,
        messageId,
        senderId,
        text,
        timestamp,
      });
      return;
    }
    if (!this.#isOwner(senderId)) return;
    await this.#runRelay(spaceId, text);
  }

  async #handleGroup(input: {
    spaceId: string;
    messageId: string;
    senderId: string | null;
    text: string;
    timestamp: string;
  }): Promise<void> {
    const { spaceId, messageId, senderId, text, timestamp } = input;
    if (!matchesMention(text, this.#mentionPatterns)) {
      await this.#bufferGroup(spaceId, messageId, senderId, text, timestamp);
      return;
    }
    if (!this.#isOwner(senderId)) {
      await this.#bufferGroup(spaceId, messageId, senderId, text, timestamp);
      return;
    }
    let channelContext: string | null;
    let consumedIds: string[];
    try {
      [channelContext, consumedIds] = this.#catchUp.readWakeSnapshot(spaceId);
    } catch (error) {
      if (error instanceof GroupCatchUpStoreError) {
        await this.#send(spaceId, "Group catch-up is unavailable; message not processed.");
        return;
      }
      throw error;
    }
    const cleaned = cleanMentionText(text, this.#mentionPatterns);
    const prompt = renderRelayPrompt(cleaned, channelContext ?? undefined);
    const success = await this.#runRelay(spaceId, prompt, { quietFailure: true });
    if (success) {
      this.#catchUp.advanceCursor(spaceId, messageId, consumedIds);
      return;
    }
    await this.#bufferGroup(spaceId, messageId, senderId, cleaned, timestamp);
  }

  async #bufferGroup(
    spaceId: string,
    messageId: string,
    senderId: string | null,
    text: string,
    timestamp: string,
  ): Promise<void> {
    try {
      this.#catchUp.append(spaceId, {
        messageId,
        senderId: senderId ?? "unknown",
        text,
        timestamp,
        senderAuthorized: this.#isOwner(senderId) ? true : senderId ? false : null,
      });
    } catch (error) {
      if (error instanceof GroupCatchUpStoreError) {
        await this.#send(spaceId, "Could not persist group message backlog.");
        return;
      }
      throw error;
    }
  }

  async #runRelay(
    spaceId: string,
    prompt: string,
    options: { quietFailure?: boolean } = {},
  ): Promise<boolean> {
    const job = this.#queue.enqueue({ target: this.#agent.id, prompt });
    const completed = await this.#queue.wait(job.id);
    if (completed.status === "completed") {
      await this.#send(spaceId, completed.output ?? "");
      return true;
    }
    if (!options.quietFailure) {
      await this.#send(spaceId, completed.error ?? "Relay failed.");
    }
    return false;
  }

  async #send(spaceId: string, text: string): Promise<void> {
    const sidecar = this.#sidecar;
    if (!sidecar || this.#stopped) return;
    await this.#post(sidecar, "/send", { spaceId, text, format: "text" });
  }

  #isOwner(senderId: string | null): boolean {
    return Boolean(senderId && this.#owners.has(senderId));
  }

  async #spawnSidecar(): Promise<SidecarBinding> {
    const port = await reservePort();
    const token = randomBytes(24).toString("hex");
    let photonEnv: Record<string, string>;
    try {
      photonEnv = this.#loadPhotonEnv(this.#photonEnvFile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `photon credentials for ${this.agentId} are invalid: ${scrubSecrets(message)}`,
      );
    }
    const env = {
      ...process.env,
      ...photonEnv,
      PHOTON_SIDECAR_PORT: String(port),
      PHOTON_SIDECAR_BIND: "127.0.0.1",
      PHOTON_SIDECAR_TOKEN: token,
      PHOTON_SIDECAR_WATCH_STDIN: "1",
    };
    this.#child = spawn("node", [this.#sidecarPath], {
      env,
      stdio: ["pipe", "inherit", "inherit"],
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const binding = { baseUrl, token };
    await waitForSidecar(binding, this.#fetchImpl);
    return binding;
  }

  async #post(sidecar: SidecarBinding, path: string, body: Record<string, unknown>): Promise<void> {
    const response = await this.#fetchImpl(`${sidecar.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Hermes-Sidecar-Token": sidecar.token,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`sidecar ${path} failed with ${response.status}`);
    }
  }
}

export class PhotonConnectorManager {
  readonly #connectors = new Map<string, PhotonConnector>();
  readonly #options: {
    agents: AgentRecord[];
    consoleHome: string;
    queue: RelayQueue;
    sidecarPath?: string;
    onError?: (message: string) => void;
  };

  constructor(options: {
    agents: AgentRecord[];
    consoleHome: string;
    queue: RelayQueue;
    sidecarPath?: string;
    onError?: (message: string) => void;
  }) {
    this.#options = options;
  }

  async start(): Promise<void> {
    for (const agent of this.#options.agents) {
      if (!agent.channels.photon) continue;
      const connector = new PhotonConnector({
        agent,
        consoleHome: this.#options.consoleHome,
        queue: this.#options.queue,
        sidecarPath: this.#options.sidecarPath,
        onError: this.#options.onError,
      });
      await connector.start();
      this.#connectors.set(agent.id, connector);
    }
  }

  async stop(): Promise<void> {
    await Promise.all([...this.#connectors.values()].map((connector) => connector.stop()));
    this.#connectors.clear();
  }

  async send(agentId: string, spaceId: string, text: string): Promise<void> {
    const connector = this.#connectors.get(agentId);
    if (!connector) throw new Error(`no photon connector for agent: ${agentId}`);
    await connector.send(spaceId, text);
  }
}

function extractText(content: PhotonContent | undefined): string | null {
  if (!content || content.type !== "text") return null;
  return content.text ?? "";
}

function scrubSecrets(message: string): string {
  return message
    .replace(/PHOTON_PROJECT_SECRET=\S+/gi, "PHOTON_PROJECT_SECRET=[redacted]")
    .replace(/PHOTON_SIDECAR_TOKEN=\S+/gi, "PHOTON_SIDECAR_TOKEN=[redacted]");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve sidecar port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForSidecar(
  sidecar: SidecarBinding,
  fetchImpl: typeof fetch,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${sidecar.baseUrl}/healthz`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Hermes-Sidecar-Token": sidecar.token,
        },
        body: "{}",
      });
      if (response.ok) return;
    } catch {
      // sidecar still booting
    }
    await sleep(50);
  }
  throw new Error("photon sidecar failed to become healthy");
}
