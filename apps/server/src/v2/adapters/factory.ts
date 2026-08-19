import type { ProviderAdapter } from "../adapter.ts";
import type { V2Provider } from "../contract.ts";
import { CodexLhcAdapter } from "./codex-lhc.ts";
import { HermesLhcAdapter } from "./hermes-lhc.ts";
import { PiLhcAdapter } from "./pi-lhc.ts";

/**
 * Exhaustive provider→adapter map. The previous inline ternary
 * (`provider === "codex-lhc" ? Codex : Pi`) would have silently routed any
 * third provider to the Pi adapter; here an unknown provider is a hard error
 * and the switch is exhaustiveness-checked at compile time.
 */
export function createProviderAdapter(provider: V2Provider): ProviderAdapter {
  switch (provider) {
    case "codex-lhc":
      return new CodexLhcAdapter();
    case "pi-lhc":
      return new PiLhcAdapter();
    case "hermes":
      return new HermesLhcAdapter();
    default: {
      const exhausted: never = provider;
      throw new Error(`no V2 adapter is registered for provider ${String(exhausted)}`);
    }
  }
}
