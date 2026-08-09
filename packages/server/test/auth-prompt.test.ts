import { describe, expect, test } from "bun:test";
import { authPromptAnswer } from "../src/auth-prompt";

describe("authPromptAnswer", () => {
  const prompt = { type: "select" as const, message: "Select login", options: [{ id: "browser", label: "Browser login (default)" }, { id: "device_code", label: "Device code login (headless)" }] };

  test("returns Pi's option id when the terminal supplies a displayed label", () => {
    expect(authPromptAnswer(prompt, "Browser login (default)")).toBe("browser");
  });

  test("uses the first option for an empty terminal response", () => {
    expect(authPromptAnswer(prompt, "")).toBe("browser");
  });
});
