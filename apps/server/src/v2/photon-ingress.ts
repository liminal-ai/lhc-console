import type { V2CommandKind } from "./contract.ts";

export type PhotonV2Control =
  | { kind: "turn.start"; text: string }
  | { kind: "turn.steer"; text: string }
  | { kind: "turn.followUp"; text: string }
  | { kind: "turn.interrupt" }
  | { kind: "status" }
  | { kind: "command.cancel"; targetCommandId: string };

const CONTROLS: Array<{ prefix: string; kind: PhotonV2Control["kind"] | "status" }> = [
  { prefix: "/v2-status", kind: "status" },
  { prefix: "/steer ", kind: "turn.steer" },
  { prefix: "/next ", kind: "turn.followUp" },
  { prefix: "/stop", kind: "turn.interrupt" },
  { prefix: "/cancel ", kind: "command.cancel" },
  { prefix: "/v2 ", kind: "turn.start" },
];

/**
 * Additive Photon parsing. Unprefixed text keeps its V1 one-shot meaning.
 * Intent is never inferred from ordinary prose.
 */
export function parsePhotonV2Control(text: string): PhotonV2Control | null {
  const trimmed = text.trim();
  for (const control of CONTROLS) {
    if (control.prefix === "/stop") {
      if (trimmed === "/stop" || trimmed.startsWith("/stop ")) {
        return { kind: "turn.interrupt" };
      }
      continue;
    }
    if (control.prefix === "/v2-status") {
      if (trimmed === "/v2-status" || trimmed.startsWith("/v2-status ")) return { kind: "status" };
      continue;
    }
    if (!trimmed.startsWith(control.prefix)) continue;
    const rest = trimmed.slice(control.prefix.length).trim();
    if (control.kind === "command.cancel") {
      return rest ? { kind: "command.cancel", targetCommandId: rest } : null;
    }
    if (control.kind === "turn.start") return rest ? { kind: "turn.start", text: rest } : null;
    if (control.kind === "turn.steer") return rest ? { kind: "turn.steer", text: rest } : null;
    if (control.kind === "turn.followUp")
      return rest ? { kind: "turn.followUp", text: rest } : null;
  }
  return null;
}

export function photonControlToCommandKind(control: PhotonV2Control): V2CommandKind | null {
  if (control.kind === "status") return null;
  return control.kind;
}
