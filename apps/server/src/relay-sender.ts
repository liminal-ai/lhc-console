import type { AgentRecord } from "./agent-registry.ts";

export function listAgentIds(agents: AgentRecord[]): string[] {
  return agents.map((agent) => agent.id).sort();
}

export function validateSenderAgent(agents: AgentRecord[], sender: string): string {
  const trimmed = sender.trim();
  if (!trimmed) throw new Error("sender is required");
  if (!agents.some((agent) => agent.id === trimmed)) {
    throw new Error(`unknown sender agent: ${trimmed}`);
  }
  return trimmed;
}

export function resolveDeclaredSender(
  agents: AgentRecord[],
  explicit?: string | null,
  envAgentId?: string | null,
): string | null {
  if (explicit?.trim()) return validateSenderAgent(agents, explicit);
  const fromEnv = envAgentId?.trim();
  if (!fromEnv) return null;
  return validateSenderAgent(agents, fromEnv);
}

export function renderSenderAttribution(sender: string, prompt: string): string {
  return `[from: ${sender}]\n${prompt}`;
}

export interface LeePhotonRoute {
  connectorAgentId: string;
  spaceId: string;
}

export function resolveLeePhotonRoute(
  agents: AgentRecord[],
  senderAgentId: string,
): LeePhotonRoute {
  const sender = agents.find((agent) => agent.id === senderAgentId);
  if (!sender) throw new Error(`unknown sender agent: ${senderAgentId}`);

  const senderSpaceId = sender.channels.photon?.notifySpaceId;
  if (sender.channels.photon && senderSpaceId) {
    return { connectorAgentId: sender.id, spaceId: senderSpaceId };
  }

  const consoleAgent = agents.find((agent) => agent.id === "console");
  const consoleSpaceId = consoleAgent?.channels.photon?.notifySpaceId;
  if (consoleAgent?.channels.photon && consoleSpaceId) {
    return { connectorAgentId: consoleAgent.id, spaceId: consoleSpaceId };
  }

  for (const agent of [...agents].sort((a, b) => a.id.localeCompare(b.id))) {
    const spaceId = agent.channels.photon?.notifySpaceId;
    if (agent.channels.photon && spaceId) {
      return { connectorAgentId: agent.id, spaceId };
    }
  }

  throw new Error("no photon connector is configured to deliver messages to Lee");
}
