import { describe, expect, test } from "bun:test";

import { JobStreamBroker } from "../src/index.ts";

describe("job stream broker", () => {
  test("cleans up terminal streams after the retention window", async () => {
    const broker = new JobStreamBroker(5);

    broker.publish("job_cleanup", {
      event: "job.completed",
      data: { output_text: "done", artifacts: [], meta: {} },
    });

    expect(broker.has("job_cleanup")).toBeTrue();
    await Bun.sleep(20);
    expect(broker.has("job_cleanup")).toBeFalse();
  });

  test("retains terminal history long enough for a late subscriber to read it", async () => {
    const broker = new JobStreamBroker(5);

    broker.publish("job_subscribed", {
      event: "job.completed",
      data: { output_text: "done", artifacts: [], meta: {} },
    });

    expect(broker.has("job_subscribed")).toBeTrue();

    const reader = broker.stream("job_subscribed").getReader();
    const first = await reader.read();
    expect(first.done).toBeFalse();
    expect(new TextDecoder().decode(first.value)).toContain("event: job.completed");

    await reader.cancel();
    await Bun.sleep(20);
    expect(broker.has("job_subscribed")).toBeFalse();
  });
});