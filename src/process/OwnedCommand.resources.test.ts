import { describe, expect, it } from "vitest";

import { ownedCommandResources } from "./OwnedCommand.js";

describe("ownedCommandResources", () => {
  it("lists run id, optional directory, and launch ownership labels", () => {
    expect(
      ownedCommandResources(
        {
          runId: "rea-artifact-decoder-abc",
          leaderPid: 42,
          processGroupId: 42,
          expectedParentPid: 1,
        },
        "/tmp/owned-123",
      ),
    ).toEqual([
      "rea-artifact-decoder-abc",
      "/tmp/owned-123",
      "pid:42",
      "process-group:42",
    ]);
  });

  it("omits the directory when none was recorded", () => {
    expect(
      ownedCommandResources({
        runId: "run",
        leaderPid: 7,
        processGroupId: 7,
        expectedParentPid: 1,
      }),
    ).toEqual(["run", "pid:7", "process-group:7"]);
  });
});
