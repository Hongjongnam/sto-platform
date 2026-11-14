import { describe, expect, it } from "vitest";
import { cash, dateTime, ERROR_EXPLANATIONS, explain, reasonText, shortAddress, shortHash, toCashUnits, units } from "./format";

describe("units", () => {
  it("groups thousands", () => {
    expect(units("1234567")).toBe("1,234,567");
    expect(units(0)).toBe("0");
    expect(units(105000n)).toBe("105,000");
  });

  it("keeps precision beyond the safe integer range", () => {
    expect(units("123456789012345678901234567890")).toBe("123,456,789,012,345,678,901,234,567,890");
  });

  it("shows a dash for missing values", () => {
    expect(units(null)).toBe("-");
    expect(units(undefined)).toBe("-");
  });
});

describe("cash", () => {
  it("converts the six-decimal smallest unit to whole cash", () => {
    expect(cash("3000000000")).toBe("3,000");
    expect(cash("1500000")).toBe("1.5");
    expect(cash("1")).toBe("0.000001");
    expect(cash("0")).toBe("0");
    expect(cash(null)).toBe("-");
  });

  it("round-trips with toCashUnits", () => {
    expect(toCashUnits("3000")).toBe("3000000000");
    expect(cash(toCashUnits("6000"))).toBe("6,000");
  });
});

describe("reasonText", () => {
  it("decodes a bytes32 reason back into its code", () => {
    expect(reasonText("0x434f5552545f4f52444552000000000000000000000000000000000000000000")).toBe("COURT_ORDER");
  });

  it("returns non-text values unchanged", () => {
    const hash = "0xdeadbeef00000000000000000000000000000000000000000000000000000000";
    expect(reasonText(hash)).toBe(hash);
    expect(reasonText(undefined)).toBe("");
    expect(reasonText("plain")).toBe("plain");
  });
});

describe("shortening", () => {
  it("abbreviates addresses and hashes", () => {
    expect(shortAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe("0xf39F…2266");
    expect(shortHash("0x7e0a1bbce744c9a3b2bcaa64dd4879cb40b6c36ffde2e58f61a06329b7606fa5")).toBe("0x7e0a1bbc…606fa5");
    expect(shortAddress(null)).toBe("-");
    expect(shortHash(undefined)).toBe("-");
  });
});

describe("dateTime", () => {
  it("formats with a fixed width", () => {
    expect(dateTime("2026-11-14T14:06:19.000Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(dateTime(null)).toBe("-");
  });
});

describe("explain", () => {
  it("explains every rejection the contracts can raise in the demo", () => {
    for (const code of ["NotVerified", "AccountFrozen", "InsufficientFreeBalance", "ComplianceRejected", "RegisteredSupplyExceeded", "TradeExists", "AlreadyClaimed", "NotEligible", "InvestorMismatch", "EnforcedPause"]) {
      expect(ERROR_EXPLANATIONS[code], code).toBeDefined();
      expect(explain(code).why.length, code).toBeGreaterThan(10);
    }
  });

  it("falls back to the code itself for an unknown rejection", () => {
    expect(explain("SomethingNew")).toEqual({ title: "SomethingNew", why: "컨트랙트가 이 호출을 거부했습니다." });
    expect(explain(null).title).toBe("알 수 없는 사유");
  });
});
