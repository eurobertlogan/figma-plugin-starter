import { describe, expect, it } from "vitest";

import { parsePluginToUiMessage, parseUiToPluginMessage } from "./messages";

describe("parseUiToPluginMessage", () => {
  it("accepts the three known messages", () => {
    expect(parseUiToPluginMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseUiToPluginMessage({ type: "cancel" })).toEqual({ type: "cancel" });
    expect(
      parseUiToPluginMessage({ type: "rename", pattern: "{name}", transform: "title" }),
    ).toEqual({ type: "rename", pattern: "{name}", transform: "title" });
  });

  it("drops unknown types and non-objects", () => {
    expect(parseUiToPluginMessage({ type: "delete-everything" })).toBeNull();
    expect(parseUiToPluginMessage("rename")).toBeNull();
    expect(parseUiToPluginMessage(null)).toBeNull();
    expect(parseUiToPluginMessage(undefined)).toBeNull();
  });

  it("drops a rename with an unknown case transform", () => {
    expect(
      parseUiToPluginMessage({ type: "rename", pattern: "{name}", transform: "camel" }),
    ).toBeNull();
  });

  it("drops a rename without a pattern", () => {
    expect(parseUiToPluginMessage({ type: "rename", transform: "keep" })).toBeNull();
  });
});

describe("parsePluginToUiMessage", () => {
  it("accepts a well-formed selection", () => {
    const message = {
      type: "selection",
      selection: {
        selectedCount: 2,
        targetCount: 5,
        scope: "children",
        names: ["A", "B", "C", "D", "E"],
      },
    };

    expect(parsePluginToUiMessage(message)).toEqual(message);
  });

  it("repairs a selection with missing fields", () => {
    expect(
      parsePluginToUiMessage({ type: "selection", selection: { scope: "layer" } }),
    ).toEqual({
      type: "selection",
      selection: { selectedCount: 0, targetCount: 0, scope: "layer", names: [] },
    });
  });

  it("rejects an unknown scope", () => {
    expect(
      parsePluginToUiMessage({ type: "selection", selection: { scope: "everything" } }),
    ).toBeNull();
  });

  it("filters malformed failures", () => {
    expect(
      parsePluginToUiMessage({
        type: "renamed",
        renamed: 3,
        failures: [{ layer: "A", reason: "locked" }, "nope"],
      }),
    ).toEqual({
      type: "renamed",
      renamed: 3,
      failures: [{ layer: "A", reason: "locked" }],
    });
  });
});
