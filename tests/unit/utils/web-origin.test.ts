import { describe, expect, it } from "vitest";
import { webOriginFor } from "../../../src/utils/web-origin";

describe("webOriginFor", () => {
  it("maps the API origin to the web app origin", () => {
    expect(webOriginFor("https://api.cirron.com")).toBe(
      "https://app.cirron.com"
    );
  });

  it("drops any path on the API URL", () => {
    expect(webOriginFor("https://api.cirron.com/api/")).toBe(
      "https://app.cirron.com"
    );
  });

  it("leaves a single-origin install untouched", () => {
    expect(webOriginFor("http://localhost:3000")).toBe("http://localhost:3000");
    expect(webOriginFor("https://acme.cirron.com")).toBe(
      "https://acme.cirron.com"
    );
  });

  it("returns an unparseable value unchanged", () => {
    expect(webOriginFor("not a url")).toBe("not a url");
  });
});
