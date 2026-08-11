#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadAgentRegistry } from "./agent-registry.ts";
import { migrateLegacyGoalsOffline } from "./goal-migrate.ts";

function parseArgs(args: string[]): { acknowledgeOffline: boolean; consoleHome: string } {
  let acknowledgeOffline = false;
  for (const arg of args) {
    if (arg === "--acknowledge-offline") acknowledgeOffline = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  const consoleHome = process.env.LHC_CONSOLE_HOME ?? join(homedir(), ".lhc-console");
  return { acknowledgeOffline, consoleHome };
}

export async function runMigrateGoalsCli(args: string[]): Promise<number> {
  const { acknowledgeOffline, consoleHome } = parseArgs(args);
  if (!acknowledgeOffline) {
    throw new Error(
      "offline migration requires --acknowledge-offline after stopping any old goals server",
    );
  }
  const agentRegistry = loadAgentRegistry(consoleHome);
  const manifest = migrateLegacyGoalsOffline({
    consoleHome,
    relayDbPath: join(consoleHome, "relay.sqlite"),
    targetExists: (target) => Object.hasOwn(agentRegistry.relayTargets, target),
    acknowledgeOffline: true,
  });
  console.log(
    `migrated ${manifest.goalCount} goal(s); source retired to ${manifest.sourceRetiredTo}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  runMigrateGoalsCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
