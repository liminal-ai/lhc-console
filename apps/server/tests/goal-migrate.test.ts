import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  GOALS_MIGRATION_MANIFEST,
  GoalMigrationManifestInvalidError,
  LegacyGoalsMigrationRequiredError,
  assertLegacyGoalsStartupSafe,
  legacyGoalsPaths,
  migrateLegacyGoalsOffline,
  readGoalMigrationManifest,
  writeGoalMigrationManifest,
} from "../src/goal-migrate.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manifestPath(dir: string): string {
  return legacyGoalsPaths(dir).manifestPath;
}

describe("Goal migration manifest", () => {
  it("returns null when manifest is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-migrate-absent-"));
    dirs.push(dir);
    expect(readGoalMigrationManifest(manifestPath(dir))).toBeNull();
    assertLegacyGoalsStartupSafe(dir);
  });

  it("fails closed on startup when manifest JSON is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-migrate-malformed-"));
    dirs.push(dir);
    writeFileSync(manifestPath(dir), "{ not json\n");
    expect(() => readGoalMigrationManifest(manifestPath(dir))).toThrow(
      GoalMigrationManifestInvalidError,
    );
    expect(() => assertLegacyGoalsStartupSafe(dir)).toThrow(GoalMigrationManifestInvalidError);
  });

  it("fails closed on unsupported manifest version", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-migrate-version-"));
    dirs.push(dir);
    writeFileSync(
      manifestPath(dir),
      `${JSON.stringify({
        version: 99,
        status: "complete",
        migratedAt: "2020-01-01T00:00:00.000Z",
        sourceRetiredTo: "/tmp/retired",
        goalCount: 0,
      })}\n`,
    );
    expect(() => readGoalMigrationManifest(manifestPath(dir))).toThrow(
      GoalMigrationManifestInvalidError,
    );
    expect(() => assertLegacyGoalsStartupSafe(dir)).toThrow(GoalMigrationManifestInvalidError);
    expect(() =>
      migrateLegacyGoalsOffline({
        consoleHome: dir,
        relayDbPath: join(dir, "relay.sqlite"),
        targetExists: () => true,
        acknowledgeOffline: true,
      }),
    ).toThrow(GoalMigrationManifestInvalidError);
  });

  it("fails closed on invalid manifest field types", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-migrate-types-"));
    dirs.push(dir);
    writeFileSync(
      manifestPath(dir),
      `${JSON.stringify({
        version: 1,
        status: "complete",
        migratedAt: "2020-01-01T00:00:00.000Z",
        sourceRetiredTo: "/tmp/retired",
        goalCount: "not-a-number",
      })}\n`,
    );
    expect(() => readGoalMigrationManifest(manifestPath(dir))).toThrow(
      GoalMigrationManifestInvalidError,
    );
    expect(() => assertLegacyGoalsStartupSafe(dir)).toThrow(GoalMigrationManifestInvalidError);
  });

  it("writes manifests atomically and ignores interrupted temp files", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-migrate-atomic-"));
    dirs.push(dir);
    const path = manifestPath(dir);
    writeGoalMigrationManifest(path, {
      version: 1,
      status: "complete",
      migratedAt: "2020-01-01T00:00:00.000Z",
      sourceRetiredTo: join(dir, "goals-retired"),
      goalCount: 2,
    });
    expect(readGoalMigrationManifest(path)).toMatchObject({ status: "complete", goalCount: 2 });

    const interruptedTemp = join(dir, `.${GOALS_MIGRATION_MANIFEST}.interrupted.tmp`);
    writeFileSync(interruptedTemp, "{ partial");
    expect(readGoalMigrationManifest(path)?.status).toBe("complete");
    expect(() => readGoalMigrationManifest(interruptedTemp)).toThrow();
    rmSync(interruptedTemp);
  });

  it("does not leave a corrupt manifest when atomic write fails before rename", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-migrate-interrupted-write-"));
    dirs.push(dir);
    const path = manifestPath(dir);
    mkdirSync(path);
    expect(() =>
      writeGoalMigrationManifest(path, {
        version: 1,
        status: "in_progress",
        migratedAt: null,
        sourceRetiredTo: null,
        goalCount: 0,
      }),
    ).toThrow();
    expect(() => readGoalMigrationManifest(path)).toThrow();
    const leftovers = readdirSync(dir).filter((entry) =>
      entry.startsWith(`.${GOALS_MIGRATION_MANIFEST}.`),
    );
    expect(leftovers).toHaveLength(0);
  });

  it("fails closed when complete manifest is present but legacy goals remain", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-console-goal-migrate-complete-legacy-"));
    dirs.push(dir);
    const { legacyGoalsPath } = legacyGoalsPaths(dir);
    writeFileSync(legacyGoalsPath, "legacy");
    writeGoalMigrationManifest(manifestPath(dir), {
      version: 1,
      status: "complete",
      migratedAt: "2020-01-01T00:00:00.000Z",
      sourceRetiredTo: join(dir, "goals-retired"),
      goalCount: 0,
    });
    expect(() => assertLegacyGoalsStartupSafe(dir)).toThrow(LegacyGoalsMigrationRequiredError);
  });
});
