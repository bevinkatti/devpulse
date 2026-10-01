import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const requestQueueModule: unknown = require("kafkajs/src/network/requestQueue");
const RequestQueue = requestQueueModule as {
  prototype: { scheduleCheckPendingRequests: () => void };
};

describe("KafkaJS request queue patch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not schedule a timeout for an empty queue", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const idleQueue = Object.assign(
      Object.create(RequestQueue.prototype) as { scheduleCheckPendingRequests: () => void },
      {
        pending: [],
        throttledUntil: -1,
        throttleCheckTimeoutId: null,
      },
    );

    idleQueue.scheduleCheckPendingRequests();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
