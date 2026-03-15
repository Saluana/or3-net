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

  test("caps retained history to the most recent events", async () => {
    const broker = new JobStreamBroker(5, 3);

    broker.publish("job_bounded", {
      event: "job.accepted",
      data: { job_id: "job_bounded" },
    });
    broker.publish("job_bounded", {
      event: "job.started",
      data: { job_id: "job_bounded" },
    });
    broker.publish("job_bounded", {
      event: "text.delta",
      data: { text: "one" },
    });
    broker.publish("job_bounded", {
      event: "text.delta",
      data: { text: "two" },
    });
    broker.publish("job_bounded", {
      event: "job.completed",
      data: { output_text: "done", artifacts: [], meta: {} },
    });

    expect(broker.history("job_bounded").map((event) => event.event)).toEqual([
      "text.delta",
      "text.delta",
      "job.completed",
    ]);

    const reader = broker.stream("job_bounded").getReader();
    const chunks: string[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      chunks.push(new TextDecoder().decode(next.value));
    }

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain("event: text.delta");
    expect(chunks[1]).toContain("event: text.delta");
    expect(chunks[2]).toContain("event: job.completed");
  });
});
