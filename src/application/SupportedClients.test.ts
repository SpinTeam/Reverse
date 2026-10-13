import { describe, expect, it } from "vitest";

import { supportedClients } from "./SupportedClients.js";

const HOME = "/home/test";

const dshClient = (env: Readonly<NodeJS.ProcessEnv>) =>
  supportedClients(HOME, "linux", env).find(({ name }) => name === "dsh");

describe("supportedClients: dsh empty-overwrite handling", () => {
  it("places the dsh patch under $DSH_HOME when set to a real directory", () => {
    const explicit = "/opt/profile";
    const result = dshClient({ DSH_HOME: explicit });

    expect(result?.configPath).toBe("/opt/profile/cordis.patch.yml");
    expect(result?.markerPath).toBe("/opt/profile");
  });

  it("falls back to ~/.dsh when DSH_HOME is unset", () => {
    const result = dshClient({});

    expect(result?.configPath).toBe(`${HOME}/.dsh/cordis.patch.yml`);
    expect(result?.markerPath).toBe(`${HOME}/.dsh`);
  });

  // Regression for https://github.com/morluto/rea/issues/2666.
  it("treats an empty DSH_HOME as unset and selects ~/.dsh (issue #2666)", () => {
    const result = dshClient({ DSH_HOME: "" });

    expect(result?.configPath).toBe(`${HOME}/.dsh/cordis.patch.yml`);
    expect(result?.markerPath).toBe(`${HOME}/.dsh`);
  });

  it("treats a whitespace-only DSH_HOME as unset and selects ~/.dsh", () => {
    const result = dshClient({ DSH_HOME: "   " });

    expect(result?.configPath).toBe(`${HOME}/.dsh/cordis.patch.yml`);
    expect(result?.markerPath).toBe(`${HOME}/.dsh`);
  });

  it("trims a whitespace-padded DSH_HOME before using it", () => {
    const explicit = "/opt/profile";
    const result = dshClient({ DSH_HOME: `  ${explicit}  ` });

    expect(result?.configPath).toBe(`${explicit}/cordis.patch.yml`);
    expect(result?.markerPath).toBe(explicit);
  });
});
