import { describe, expect, test } from "bun:test";
import { MuseInvalidConfigError } from "../../src/errors.js";
import {
  APPROVAL_MODE_ENV,
  approvalModeWireValue,
  resolveApprovalMode,
} from "../../src/msp/approval-mode.js";

describe("approvalMode option", () => {
  test("approvalMode.defaultsToOnRequestWhenUnset", () => {
    expect(resolveApprovalMode(undefined)).toBe("onRequest");
  });

  test("approvalMode.acceptsTheClosedModeSetCaseInsensitively", () => {
    expect(resolveApprovalMode("onRequest")).toBe("onRequest");
    expect(resolveApprovalMode("allowAll")).toBe("allowAll");
    expect(resolveApprovalMode("promptUnmatched")).toBe("promptUnmatched");
    expect(resolveApprovalMode("denyUnmatched")).toBe("denyUnmatched");
    expect(resolveApprovalMode(" ALLOWALL ")).toBe("allowAll");
    expect(resolveApprovalMode("onrequest")).toBe("onRequest");
  });

  test("approvalMode.acceptsHostDefaultOptIn", () => {
    expect(resolveApprovalMode("host-default")).toBe("host-default");
    expect(resolveApprovalMode(" Host-Default ")).toBe("host-default");
  });

  test("approvalMode.rejectsAnythingElse", () => {
    for (const raw of ["", "yolo", "unrestricted", "true", "1", "allow-all", "host default", 5]) {
      let error: unknown;
      try {
        resolveApprovalMode(raw);
      } catch (reason) {
        error = reason;
      }
      expect(error).toBeInstanceOf(MuseInvalidConfigError);
    }
  });

  test("approvalMode.envNameIsNamespaced", () => {
    expect(APPROVAL_MODE_ENV).toBe("OPENCODE_MUSE_APPROVAL_MODE");
  });

  test("approvalMode.wireValueOmitsOnlyForHostDefault", () => {
    expect(approvalModeWireValue("host-default")).toBeUndefined();
    expect(approvalModeWireValue("onRequest")).toBe("onRequest");
    expect(approvalModeWireValue("allowAll")).toBe("allowAll");
    expect(approvalModeWireValue("promptUnmatched")).toBe("promptUnmatched");
    expect(approvalModeWireValue("denyUnmatched")).toBe("denyUnmatched");
  });
});
