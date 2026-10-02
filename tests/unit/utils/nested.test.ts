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

describe("getNestedValue on prototype paths", () => {
  it.each(["__proto__", "constructor", "a.constructor", "toString"])(
    "returns undefined for %s rather than an inherited value",
    (keyPath) => {
      expect(getNestedValue({ a: {} }, keyPath)).toBeUndefined();
    }
  );
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

  it("rejects a __proto__ path and leaves Object.prototype untouched", () => {
    // This inverts the test that pinned the unguarded behavior. The cleanup
    // stays in a `finally`: if the guard ever regresses, the pollution is
    // global to the Vitest worker and would break unrelated tests.
    const marker = "__cirronNestedProtoPin__";
    const obj: Record<string, unknown> = {};

    try {
      expect(() => setNestedValue(obj, `__proto__.${marker}`, "yes")).toThrow(
        /"__proto__" is not allowed/
      );
      expect(Object.hasOwn(obj, marker)).toBe(false);
      expect(({} as Record<string, unknown>)[marker]).toBeUndefined();
    } finally {
      delete (Object.prototype as Record<string, unknown>)[marker];
    }
  });

  it.each(["constructor.prototype.polluted", "a.constructor.x", "a.prototype"])(
    "rejects the path %s",
    (keyPath) => {
      const obj: Record<string, unknown> = { a: {} };
      try {
        expect(() => setNestedValue(obj, keyPath, "yes")).toThrow(
          /is not allowed/
        );
        expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
      } finally {
        delete (Object.prototype as Record<string, unknown>)["polluted"];
      }
    }
  );

  it("throws a clear error when an intermediate value is a primitive", () => {
    const obj = { a: 1 };
    expect(() => setNestedValue(obj, "a.b", 2)).toThrow(
      'Cannot set "a.b": "a" is not an object'
    );
    expect(obj).toEqual({ a: 1 });
  });

  it("treats a null intermediate as not an object", () => {
    const obj = { a: { b: null } };
    expect(() => setNestedValue(obj, "a.b.c", 1)).toThrow(
      /"a.b" is not an object/
    );
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

describe("deleteNestedValue on prototype paths", () => {
  it.each(["__proto__", "constructor", "a.__proto__.x", "toString"])(
    "reports false for %s and deletes nothing",
    (keyPath) => {
      const obj = { a: { x: 1 } };
      expect(deleteNestedValue(obj, keyPath)).toBe(false);
      expect(obj).toEqual({ a: { x: 1 } });
      expect(typeof Object.prototype.toString).toBe("function");
    }
  );
});
