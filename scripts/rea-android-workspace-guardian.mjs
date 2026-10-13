#!/usr/bin/env node

import { setTimeout as delay } from "node:timers/promises";
import { WindowsPrivateRuntime } from "../dist/windows/WindowsPrivateRuntime.js";

if (process.platform !== "win32" || process.argv.length !== 3)
  throw new Error(
    "Android workspace guardian requires Windows and one parent directory",
  );

// This process owns the native directory handle. Detached process creation
// keeps it alive when the REA owner is terminated without running JS cleanup.
const runtime = WindowsPrivateRuntime.create(process.argv[2], "rea-android-");
process.stdout.write(
  JSON.stringify({
    path: runtime.observation.path,
    volumeSerial: runtime.observation.volumeSerial,
    fileId: runtime.observation.fileId,
    privateDacl: runtime.observation.privateDacl,
  }) + "\n",
);

// The owner holds the write end of this pipe until its normal close or death.
for await (const _ of process.stdin) {
  // No commands are accepted; only EOF grants cleanup authority.
}

// A failed native walk retains the directory identity lease for a later retry.
// Keep this process alive so a transient sharing violation cannot orphan it.
for (;;) {
  try {
    await runtime.close();
    process.exit(0);
  } catch {
    await delay(1000);
  }
}
