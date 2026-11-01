import { describe, expect, test } from "bun:test";
import {
  assertContributorFlagSupported,
  baseServeArgs,
  contributorServeArgs,
  museChildEnv,
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

  test("contributor.childEnvStripsBillingKeysAndPinsNoAutoUpdate", () => {
    const source = {
      PATH: "/bin",
      META_API_KEY: "secret",
      MUSE_CONTRIBUTOR_MODE: "off",
      Meta_Api_Key: "odd-case",
      MUSE_NO_AUTO_UPDATE: "0",
    };
    const cleaned = museChildEnv(source);
    expect(cleaned.META_API_KEY).toBeUndefined();
    expect(cleaned.MUSE_CONTRIBUTOR_MODE).toBeUndefined();
    expect("Meta_Api_Key" in cleaned).toBe(false);
    expect(cleaned.PATH).toBe("/bin");
    expect(cleaned.MUSE_NO_AUTO_UPDATE).toBe("1");
    expect(source.META_API_KEY).toBe("secret");
  });

  test("contributor.childEnvDropsUndefinedValuesAndKeepsTheRest", () => {
    const cleaned = museChildEnv({ KEEP: "1", GONE: undefined });
    expect(cleaned.KEEP).toBe("1");
    expect("GONE" in cleaned).toBe(false);
  });

  test("contributor.paygNoticePointsAtTheOfficialPathWithoutReadingTheKey", () => {
    const notice = paygBillingNotice({ META_API_KEY: "sk-ant-secret-sentinel" });
    expect(notice).toContain("metamate");
    expect(notice).not.toContain("sk-ant-secret-sentinel");
    expect(paygBillingNotice({})).toBeUndefined();
    expect(paygBillingNotice(undefined)).toBeUndefined();
  });
});
