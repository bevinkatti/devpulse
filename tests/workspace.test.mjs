import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("DevPulse workspace", () => {
  it("declares the local migration and verification commands", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    );
    expect(packageJson.name).toBe("devpulse");
    expect(packageJson.scripts["db:migrate"]).toBeDefined();
    expect(packageJson.scripts.test).toBe("vitest run");
  });
});
