import { describe, expect, it } from "vite-plus/test";
import {
  TEST_ONLY_OWNER_POLICIES,
  UnsettledOwnerPolicyError,
  describeUnsetOwnerDecisions,
  parseV2OwnerPolicies,
  resolveConfiguredOwnerPolicies,
  testOnlyOwnerPolicies,
} from "../src/v2/policies.ts";

describe("V2 owner policies Q1–Q4", () => {
  it("refuses to invent a product default when no policy object is supplied", () => {
    expect(() => parseV2OwnerPolicies(undefined)).toThrow(UnsettledOwnerPolicyError);
    expect(() => parseV2OwnerPolicies({})).toThrow(/Q1/);
    expect(describeUnsetOwnerDecisions().Q2).toMatch(/children versus detached/);
  });

  it("accepts an explicit owner-configured object without treating it as a default", () => {
    const resolved = resolveConfiguredOwnerPolicies({
      authToken: "owner-only-v2-token",
      runtimeProcess: "detached",
      heldFollowUpResume: "resume",
      codexApprovals: "surface-server-requests",
    });
    expect(resolved.source).toBe("explicit");
    expect(resolved.testOnly).toBeUndefined();
    expect(resolved.policies).toEqual({
      authToken: "owner-only-v2-token",
      runtimeProcess: "detached",
      heldFollowUpResume: "resume",
      codexApprovals: "surface-server-requests",
    });
  });

  it("labels the fixture policies as test-only, not product behavior", () => {
    const resolved = testOnlyOwnerPolicies(TEST_ONLY_OWNER_POLICIES);
    expect(resolved.source).toBe("test-only");
    expect(resolved.testOnly).toBe(true);
    expect(TEST_ONLY_OWNER_POLICIES.runtimeProcess).toBe("console-child");
  });

  it("keeps each open decision independently selectable", () => {
    const q2Detached = parseV2OwnerPolicies({
      ...TEST_ONLY_OWNER_POLICIES,
      runtimeProcess: "detached",
    });
    const q3Resume = parseV2OwnerPolicies({
      ...TEST_ONLY_OWNER_POLICIES,
      heldFollowUpResume: "resume",
    });
    expect(q2Detached.runtimeProcess).toBe("detached");
    expect(q3Resume.heldFollowUpResume).toBe("resume");
    expect(q2Detached.heldFollowUpResume).toBe("hold");
  });
});
