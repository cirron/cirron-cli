import { describe, expect, it } from "vitest";
import {
  deleteNestedValue,
  getNestedValue,
  setNestedValue,
} from "../../../src/utils/nested";

/**
 * These back `cirron config get/set` and `cirron settings`, so the dotted-path
 * semantics are a user-facing contract.
 */
describe("getNestedValue", () => {
  it("reads a top-level key", () => {
    expect(getNestedValue({ a: 1 }, "a")).toBe(1);
  });

  it("reads a deep path", () => {
    expect(getNestedValue({ a: { b: { c: "deep" } } }, "a.b.c")).toBe("deep");
  });

  it("returns undefined for a missing leaf", () => {
    expect(getNestedValue({ a: { b: {} } }, "a.b.c")).toBeUndefined();
  });

  it("returns undefined rather than throwing on a missing intermediate", () => {
    expect(getNestedValue({ a: 1 }, "x.y.z")).toBeUndefined();
  });

  it("preserves falsy values", () => {
    expect(getNestedValue({ a: { b: false } }, "a.b")).toBe(false);
    expect(getNestedValue({ a: { b: 0 } }, "a.b")).toBe(0);
    expect(getNestedValue({ a: { b: "" } }, "a.b")).toBe("");
  });
});

describe("setNestedValue", () => {
  it("sets a top-level key", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "a", 1);
    expect(obj).toEqual({ a: 1 });
  });

  it("creates missing intermediate objects", () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "a.b.c", "deep");
    expect(obj).toEqual({ a: { b: { c: "deep" } } });
  });

  it("overwrites an existing value without disturbing siblings", () => {
    const obj = { a: { b: 1, keep: 2 } };
    setNestedValue(obj, "a.b", 99);
    expect(obj).toEqual({ a: { b: 99, keep: 2 } });
  });

  it("PINS CURRENT BEHAVIOR: a __proto__ path is not guarded", () => {
    // Intermediate creation uses an unguarded `key in current` check, so a
    // path through __proto__ reaches the prototype rather than being
    // rejected. This test documents today's behavior so a future hardening
    // change is deliberate and visible, not an accidental side effect.
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, "__proto__.polluted", "yes");

    // The write lands on the object's prototype, not as an own key.
    expect(Object.hasOwn(obj, "polluted")).toBe(false);
    // And it is therefore visible from an unrelated object.
    expect(({} as Record<string, unknown>).polluted).toBe("yes");

    // Clean up so the pollution cannot leak into other tests.
    delete (Object.prototype as Record<string, unknown>).polluted;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("deleteNestedValue", () => {
  it("deletes a top-level key and reports success", () => {
    const obj: Record<string, unknown> = { a: 1, b: 2 };
    expect(deleteNestedValue(obj, "a")).toBe(true);
    expect(obj).toEqual({ b: 2 });
  });

  it("deletes a deep key", () => {
    const obj = { a: { b: { c: 1, d: 2 } } };
    expect(deleteNestedValue(obj, "a.b.c")).toBe(true);
    expect(obj).toEqual({ a: { b: { d: 2 } } });
  });

  it("reports false for a missing leaf", () => {
    expect(deleteNestedValue({ a: { b: 1 } }, "a.missing")).toBe(false);
  });

  it("reports false for a missing intermediate rather than throwing", () => {
    expect(deleteNestedValue({ a: 1 }, "x.y.z")).toBe(false);
  });

  it("deletes a key whose value is undefined, since it is still present", () => {
    const obj = { a: { b: undefined } };
    expect(deleteNestedValue(obj, "a.b")).toBe(true);
    expect(Object.hasOwn(obj.a, "b")).toBe(false);
  });
});
