import { describe, expect, test } from "bun:test";
import {
  assertContributorFlagSupported,
  baseServeArgs,
  contributorServeArgs,
  paygBillingNotice,
  resolveContributorMode,
} from "../../src/msp/contributor.js";
import { MuseInvalidConfigError } from "../../src/errors.js";

describe("Contributor billing lane", () => {
  test("contributor.defaultsToOnWhenUnset", () => {
    expect(resolveContributorMode(undefined)).toBe("on");
  });

  test("contributor.acceptsExplicitBooleansAndFlagStrings", () => {
    expect(resolveContributorMode(true)).toBe("on");
    expect(resolveContributorMode(false)).toBe("off");
    expect(resolveContributorMode("on")).toBe("on");
    expect(resolveContributorMode("off")).toBe("off");
    expect(resolveContributorMode(" ON ")).toBe("on");
  });

  test("contributor.rejectsAnythingElseFailClosed", () => {
    for (const raw of ["sometimes", 42, {}, ["on"], "default"]) {
      let error: unknown;
      try {
        resolveContributorMode(raw);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(MuseInvalidConfigError);
      expect((error as MuseInvalidConfigError).code).toBe("MUSE_INVALID_CONFIG");
    }
  });

  test("contributor.buildsThePerProcessServeFlag", () => {
    expect(contributorServeArgs("on")).toEqual(["--contributor-mode", "on"]);
    expect(contributorServeArgs("off")).toEqual(["--contributor-mode", "off"]);
  });

  test("contributor.buildsOneBaseArgvForEveryServeHost", () => {
    expect(baseServeArgs("meta", "on")).toEqual(["serve", "--provider", "meta", "--contributor-mode", "on"]);
    expect(baseServeArgs("meta", "off")).toEqual(["serve", "--provider", "meta", "--contributor-mode", "off"]);
  });

  test("contributor.capabilityCheckPassesWhenTheCliAdvertisesTheFlag", async () => {
    await assertContributorFlagSupported("muse", async () => ({ stdout: "--contributor-mode <on|off>\n" }));
  });

  test("contributor.capabilityCheckFailsClosedWithoutTheFlag", async () => {
    const error = await assertContributorFlagSupported("muse", async () => ({ stdout: "--provider <name>\n" })).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MuseInvalidConfigError);
    expect((error as MuseInvalidConfigError).code).toBe("MUSE_INVALID_CONFIG");
    expect((error as Error).message).toContain("--contributor-mode");
  });

  test("contributor.capabilityCheckFailsClosedWhenHelpCannotRun", async () => {
    const error = await assertContributorFlagSupported("muse", async () => {
      throw new Error("spawn ENOENT");
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(MuseInvalidConfigError);
    // Raw spawn stderr must never leak into the message.
    expect((error as Error).message).not.toContain("ENOENT");
  });

  test("contributor.paygNoticePointsAtTheOfficialPathWithoutReadingTheKey", () => {
    const notice = paygBillingNotice({ META_API_KEY: "sk-ant-secret-sentinel" });
    expect(notice).toContain("metamate");
    expect(notice).not.toContain("sk-ant-secret-sentinel");
    expect(paygBillingNotice({})).toBeUndefined();
    expect(paygBillingNotice(undefined)).toBeUndefined();
  });
});
