import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { loadEnvFile, loadPhotonEnvFile } from "../src/env-file.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadPhotonEnvFile", () => {
  it("rejects env files readable by group or other", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-env-"));
    dirs.push(dir);
    const path = join(dir, "leaky.env");
    writeFileSync(path, "PHOTON_PROJECT_ID=p1\nPHOTON_PROJECT_SECRET=s1\n", { mode: 0o644 });
    expect(() => loadPhotonEnvFile(path)).toThrow(/owner-only/);
  });

  it("requires nonempty PHOTON_PROJECT_ID and PHOTON_PROJECT_SECRET", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-env-"));
    dirs.push(dir);
    const path = join(dir, "incomplete.env");
    writeFileSync(path, "PHOTON_PROJECT_ID=p1\n", { mode: 0o600 });
    expect(() => loadPhotonEnvFile(path)).toThrow(/PHOTON_PROJECT_SECRET/);
  });

  it("loads owner-only photon credentials without exposing secret values in errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "lhc-photon-env-"));
    dirs.push(dir);
    const path = join(dir, "good.env");
    writeFileSync(path, "PHOTON_PROJECT_ID=proj\nPHOTON_PROJECT_SECRET=sekret\n", {
      mode: 0o600,
    });
    expect(loadPhotonEnvFile(path)).toEqual({
      PHOTON_PROJECT_ID: "proj",
      PHOTON_PROJECT_SECRET: "sekret",
    });
    chmodSync(path, 0o600);
    expect(loadEnvFile(path).PHOTON_PROJECT_SECRET).toBe("sekret");
  });
});
