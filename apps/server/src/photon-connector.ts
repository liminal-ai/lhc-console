import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import type { AgentRecord } from "./agent-registry.ts";
import { loadPhotonEnvFile } from "./env-file.ts";
import {
  GroupCatchUpStore,
  GroupCatchUpStoreError,
  GroupBacklogLimitError,
  resolveBacklogLimits,
  type GroupWakeDeliveryMetadata,
} from "./group-catch-up.ts";
import { InboundDedupeStore } from "./inbound-dedupe.ts";
import { cleanMentionText, compileMentionPatterns, matchesMention } from "./mention-patterns.ts";
import type { RelayQueue } from "./relay.ts";
import { renderRelayPrompt } from "./relay-prompt.ts";
import { parsePhotonV2Control } from "./v2/photon-ingress.ts";
import type { RuntimeManager } from "./v2/manager.ts";

const DEFAULT_SIDECAR_PATH =
  process.env.LHC_PHOTON_SIDECAR_PATH ??
  "/srv/work/hermes-agent/plugins/platforms/photon/sidecar/index.mjs";

const MAX_SIDECAR_BACKOFF_MS = 30_000;
const STOP_TIMEOUT_MS = 2_000;
const INBOUND_SETTLE_TIMEOUT_MS = STOP_TIMEOUT_MS;
const INBOUND_RECONNECT_MS = 250;
const PHONE_REPLY_GUIDANCE =
  "[Response style for iMessage: write for a phone screen. Use controlled English inspired by ASD-STE100 as a general default, not as strict compliance. Answer first. Use short sentences and one idea per sentence. Prefer active voice, concrete words, and explicit subjects. Keep established project terms unchanged. Use short paragraphs, compact bullets only when they improve scanning, simple headings, and restrained bold. Keep code blocks brief. Avoid long preambles, raw IDs, internal jargon, narrative, reassurance, and background unless needed for the current request. For status updates, state the current state, the next action, and whether Lee must act. Use emojis sparingly and only when they add useful status or tone.]";
const URL_PATTERN = /https?:\/\/\S+/i;

function plainTextForPhoton(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/gi, "$1 ($2)")
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

interface GroupWakeMetadata extends GroupWakeDeliveryMetadata {}

export interface PhotonConnectorOptions {
  agent: AgentRecord;
  consoleHome: string;
  queue: RelayQueue;
  v2?: RuntimeManager | null;
  sidecar?: SidecarBinding;
  sidecarPath?: string;
  fetchImpl?: typeof fetch;
  loadPhotonEnv?: (path: string) => Record<string, string>;
  onError?: (message: string) => void;
  backlogLimits?: ReturnType<typeof resolveBacklogLimits>;
  spawnChild?: typeof spawn;
  spawnSidecar?: (options: {
    sidecarPath: string;
    photonEnv: Record<string, string>;
    port: number;
    token: string;
  }) => ChildProcess;
}

export class PhotonConnector {
  readonly agentId: string;
  readonly #agent: AgentRecord;
  readonly #queue: RelayQueue;
  readonly #v2: RuntimeManager | null;
  readonly #sidecarPath: string;
  readonly #fetchImpl: typeof fetch;
  readonly #loadPhotonEnv: (path: string) => Record<string, string>;
  readonly #onError: (message: string) => void;
  readonly #owners: Set<string>;
  readonly #mentionPatterns: RegExp[];
  readonly #catchUp: GroupCatchUpStore;
  readonly #dedupe: InboundDedupeStore;
  readonly #photonEnvFile: string;
  readonly #spawnChild: typeof spawn;
  readonly #spawnSidecar: PhotonConnectorOptions["spawnSidecar"];
  readonly #injectedSidecar?: SidecarBinding;
  #sidecar?: SidecarBinding;
  #child: ChildProcess | null = null;
  #abort: AbortController | null = null;
  #inboundTask: Promise<void> | null = null;
  #processing: Promise<void> = Promise.resolve();
  #sidecarRespawnTimer: NodeJS.Timeout | null = null;
  #sidecarRespawnAttempt = 0;
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
    this.#v2 = options.v2 ?? null;
    this.#sidecarPath = options.sidecarPath ?? DEFAULT_SIDECAR_PATH;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#loadPhotonEnv = options.loadPhotonEnv ?? loadPhotonEnvFile;
    this.#onError = options.onError ?? ((message) => console.error(message));
    this.#photonEnvFile = photon.envFile;
    this.#owners = new Set(options.agent.ownerSenderIds);
    this.#mentionPatterns = compileMentionPatterns(options.agent.mentionPatterns);
    this.#spawnChild = options.spawnChild ?? spawn;
    this.#spawnSidecar = options.spawnSidecar;
    const stateDir = join(options.consoleHome, "agents", options.agent.id);
    const backlogLimits = options.backlogLimits ?? resolveBacklogLimits();
    this.#catchUp = new GroupCatchUpStore(join(stateDir, "group-catch-up.sqlite"), backlogLimits);
    this.#dedupe = new InboundDedupeStore(join(stateDir, "inbound-dedupe.sqlite"));
    this.#injectedSidecar = options.sidecar;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#sidecar = this.#injectedSidecar ?? (await this.#startManagedSidecar());
    this.#abort = new AbortController();
    this.#inboundTask = this.#consumeInbound(this.#abort.signal);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#sidecarRespawnTimer) {
      clearTimeout(this.#sidecarRespawnTimer);
      this.#sidecarRespawnTimer = null;
    }
    this.#abort?.abort();
    const inbound = this.#inboundTask;
    if (inbound) {
      await Promise.race([inbound.catch(() => undefined), sleep(STOP_TIMEOUT_MS)]);
    }
    if (this.#sidecar && !this.#injectedSidecar) {
      await this.#post(this.#sidecar, "/shutdown", {}, AbortSignal.timeout(STOP_TIMEOUT_MS)).catch(
        () => undefined,
      );
    }
    if (this.#child) {
      this.#child.stdin?.end();
      this.#child.kill("SIGTERM");
      this.#child = null;
    }
  }

  async send(spaceId: string, text: string): Promise<void> {
    const sidecar = this.#sidecar;
    if (!sidecar) throw new Error(`photon connector for ${this.agentId} is not running`);
    const markdown = photonMarkdownEnabled() && !URL_PATTERN.test(text);
    await this.#post(sidecar, "/send", {
      spaceId,
      text: markdown ? text : plainTextForPhoton(text),
      format: markdown ? "markdown" : "text",
    });
  }

  async typing(spaceId: string, state: "start" | "stop"): Promise<void> {
    const sidecar = this.#sidecar;
    if (!sidecar) throw new Error(`photon connector for ${this.agentId} is not running`);
    await this.#post(sidecar, "/typing", { spaceId, state });
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
    while (!signal.aborted && !this.#stopped) {
      const sidecar = this.#sidecar;
      if (!sidecar) {
        if (signal.aborted) return;
        await abortableSleep(INBOUND_RECONNECT_MS, signal);
        continue;
      }
      try {
        const response = await this.#fetchImpl(`${sidecar.baseUrl}/inbound`, {
          headers: { "X-Hermes-Sidecar-Token": sidecar.token },
          signal,
        });
        if (!response.ok || !response.body) {
          await abortableSleep(INBOUND_RECONNECT_MS, signal);
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
        if (!signal.aborted && !this.#stopped) {
          await abortableSleep(INBOUND_RECONNECT_MS, signal);
        }
      } catch (error) {
        if (signal.aborted || this.#stopped) return;
        this.#reportProcessingError(error);
        await abortableSleep(INBOUND_RECONNECT_MS, signal);
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
    const claim = this.#dedupe.begin(spaceId, messageId);
    if (claim.gate === "skip") return;
    try {
      if (await this.#handleV2Control(spaceId, text)) {
        this.#dedupe.complete(spaceId, messageId, claim.token);
        return;
      }
      this.#enqueueRelay(spaceId, text);
      this.#dedupe.complete(spaceId, messageId, claim.token);
    } catch (error) {
      this.#dedupe.release(spaceId, messageId, claim.token);
      throw error;
    }
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
    const claim = this.#dedupe.begin(spaceId, messageId);
    if (claim.gate === "skip") return;
    let channelContext: string | null;
    let consumedIds: string[];
    try {
      [channelContext, consumedIds] = this.#catchUp.readWakeSnapshot(spaceId);
    } catch (error) {
      if (error instanceof GroupBacklogLimitError) {
        await this.#send(spaceId, `${error.message}; backlog retained.`);
        this.#dedupe.complete(spaceId, messageId, claim.token);
        return;
      }
      if (error instanceof GroupCatchUpStoreError) {
        await this.#send(spaceId, "Group catch-up is unavailable; message not processed.");
        this.#dedupe.release(spaceId, messageId, claim.token);
        return;
      }
      this.#dedupe.release(spaceId, messageId, claim.token);
      throw error;
    }
    const cleaned = cleanMentionText(text, this.#mentionPatterns);
    const prompt = renderRelayPrompt(cleaned, channelContext ?? undefined);
    try {
      if (await this.#handleV2Control(spaceId, cleaned)) {
        this.#catchUp.advanceCursor(spaceId, messageId, consumedIds);
        this.#dedupe.complete(spaceId, messageId, claim.token);
        return;
      }
      this.#enqueueRelay(spaceId, prompt, {
        kind: "photon_group_wake",
        spaceId,
        wakeMessageId: messageId,
        consumedIds,
        fallback: {
          messageId,
          senderId,
          text: cleaned,
          timestamp,
        },
      });
      this.#dedupe.complete(spaceId, messageId, claim.token);
    } catch (error) {
      this.#dedupe.release(spaceId, messageId, claim.token);
      throw error;
    }
  }

  async #bufferGroup(
    spaceId: string,
    messageId: string,
    senderId: string | null,
    text: string,
    timestamp: string,
  ): Promise<void> {
    const claim = this.#dedupe.begin(spaceId, messageId);
    if (claim.gate === "skip") return;
    try {
      this.#catchUp.append(spaceId, {
        messageId,
        senderId: senderId ?? "unknown",
        text,
        timestamp,
        senderAuthorized: this.#isOwner(senderId) ? true : senderId ? false : null,
      });
      this.#dedupe.complete(spaceId, messageId, claim.token);
    } catch (error) {
      this.#dedupe.release(spaceId, messageId, claim.token);
      if (error instanceof GroupBacklogLimitError) {
        await this.#send(spaceId, `${error.message}; backlog retained.`);
        return;
      }
      if (error instanceof GroupCatchUpStoreError) {
        await this.#send(spaceId, "Could not persist group message backlog.");
        return;
      }
      throw error;
    }
  }

  async #handleV2Control(spaceId: string, text: string): Promise<boolean> {
    const control = parsePhotonV2Control(text);
    if (!control) return false;
    if (!this.#v2 || !this.#agent.v2) {
      // Unprefixed text already stays V1. Explicit /v2 syntax on a V1-only
      // target must also stay on the one-shot plane rather than consuming the
      // message as a V2 acknowledgement.
      return false;
    }
    try {
      if (control.kind === "status") {
        const status = this.#v2.status(this.#agent.id);
        await this.#send(
          spaceId,
          `v2 ${status.target} ${status.state} turn=${status.currentTurn?.turnId ?? "-"} seq=${status.lastEventSeq}`,
        );
        return true;
      }
      const commandId = crypto.randomUUID();
      const params =
        control.kind === "turn.start"
          ? { text: control.text, delivery: "photon" }
          : control.kind === "turn.steer"
            ? {
                text: control.text,
                expectedTurnId: this.#v2.status(this.#agent.id).currentTurn?.turnId,
              }
            : control.kind === "turn.followUp"
              ? {
                  text: control.text,
                  afterTurnId: this.#v2.status(this.#agent.id).currentTurn?.turnId,
                  delivery: "photon",
                }
              : control.kind === "turn.interrupt"
                ? { expectedTurnId: this.#v2.status(this.#agent.id).currentTurn?.turnId }
                : { targetCommandId: control.targetCommandId };
      const receipt = await this.#v2.submit({
        target: this.#agent.id,
        commandId,
        kind: control.kind,
        params,
      });
      await this.#send(
        spaceId,
        `v2 ${receipt.kind} ${receipt.commandId} ${receipt.state}${receipt.reason ? ` ${receipt.reason}` : ""}`,
      );
    } catch (error) {
      await this.#send(spaceId, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  #enqueueRelay(spaceId: string, prompt: string, groupWake?: GroupWakeMetadata): void {
    this.#queue.enqueue({
      target: this.#agent.id,
      prompt: `${prompt}\n\n${PHONE_REPLY_GUIDANCE}`,
      jobClass: "prioritized",
      delivery: {
        channel: "photon",
        destination: { spaceId },
        ...(groupWake ? { metadata: groupWake } : {}),
      },
    });
  }

  async #send(spaceId: string, text: string): Promise<void> {
    const sidecar = this.#sidecar;
    if (!sidecar || this.#stopped) return;
    await this.#post(sidecar, "/send", {
      spaceId,
      text,
      format: photonMarkdownEnabled() ? "markdown" : "text",
    });
  }

  #isOwner(senderId: string | null): boolean {
    return Boolean(senderId && this.#owners.has(senderId));
  }

  async #startManagedSidecar(): Promise<SidecarBinding> {
    return this.#spawnSidecarProcess();
  }

  async #spawnSidecarProcess(): Promise<SidecarBinding> {
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
    if (this.#spawnSidecar) {
      this.#child = this.#spawnSidecar({
        sidecarPath: this.#sidecarPath,
        photonEnv,
        port,
        token,
      });
    } else {
      this.#child = this.#spawnChild("node", [this.#sidecarPath], {
        env,
        stdio: ["pipe", "inherit", "inherit"],
      });
    }
    if (!this.#injectedSidecar) this.#attachSidecarSupervision();
    const baseUrl = `http://127.0.0.1:${port}`;
    const binding = { baseUrl, token };
    await waitForSidecar(binding, this.#fetchImpl);
    this.#sidecarRespawnAttempt = 0;
    return binding;
  }

  #attachSidecarSupervision(): void {
    const child = this.#child as ChildProcess & EventEmitter & { __lhcSupervised?: boolean };
    if (!child || child.__lhcSupervised || this.#injectedSidecar) return;
    child.__lhcSupervised = true;
    const supervisedChild = child;
    let handled = false;
    const onExit = () => {
      if (handled) return;
      handled = true;
      supervisedChild.removeListener("exit", onExit);
      supervisedChild.removeListener("error", onError);
      if (this.#stopped) return;
      if (this.#child !== supervisedChild) return;
      this.#abort?.abort();
      this.#child = null;
      this.#sidecar = undefined;
      this.#scheduleSidecarRespawn();
    };
    const onError = () => onExit();
    child.once("exit", onExit);
    child.once("error", onError);
  }

  #scheduleSidecarRespawn(): void {
    if (this.#stopped || this.#sidecarRespawnTimer || this.#injectedSidecar) return;
    const delay = Math.min(250 * 2 ** this.#sidecarRespawnAttempt, MAX_SIDECAR_BACKOFF_MS);
    this.#sidecarRespawnAttempt += 1;
    this.#sidecarRespawnTimer = setTimeout(() => {
      this.#sidecarRespawnTimer = null;
      void this.#respawnSidecar();
    }, delay);
  }

  async #respawnSidecar(): Promise<void> {
    if (this.#stopped || this.#injectedSidecar) return;
    const oldInbound = this.#inboundTask;
    if (oldInbound) {
      let settled = false;
      await Promise.race([
        oldInbound
          .then(() => {
            settled = true;
          })
          .catch(() => {
            settled = true;
          }),
        sleep(INBOUND_SETTLE_TIMEOUT_MS),
      ]);
      if (!settled) {
        this.#scheduleSidecarRespawn();
        return;
      }
    }
    try {
      const binding = await this.#spawnSidecarProcess();
      this.#sidecar = binding;
      this.#abort = new AbortController();
      this.#inboundTask = this.#consumeInbound(this.#abort.signal);
    } catch (error) {
      this.#reportProcessingError(error);
      this.#scheduleSidecarRespawn();
    }
  }

  async #post(
    sidecar: SidecarBinding,
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#fetchImpl(`${sidecar.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Hermes-Sidecar-Token": sidecar.token,
      },
      body: JSON.stringify(body),
      signal,
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
    v2?: RuntimeManager | null;
  };

  constructor(options: {
    agents: AgentRecord[];
    consoleHome: string;
    queue: RelayQueue;
    sidecarPath?: string;
    onError?: (message: string) => void;
    v2?: RuntimeManager | null;
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
        v2: this.#options.v2,
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

  async typing(agentId: string, spaceId: string, state: "start" | "stop"): Promise<void> {
    const connector = this.#connectors.get(agentId);
    if (!connector) throw new Error(`no photon connector for agent: ${agentId}`);
    await connector.typing(spaceId, state);
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

function photonMarkdownEnabled(): boolean {
  const value = process.env.LHC_PHOTON_MARKDOWN ?? process.env.PHOTON_MARKDOWN ?? "true";
  return !["false", "0", "no"].includes(value.trim().toLowerCase());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
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
