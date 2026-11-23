import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { throttleProgress } from "../src/app/throttle.ts";
import type { FlowState } from "../src/app/view.ts";

const PAIRING = {
  primary: { id: "P", name: "Primary" },
  replica: { id: "R", name: "Replica" },
};
const comparing = (scanned: number): FlowState => ({ step: "comparing", pairing: PAIRING, progress: { phase: "scanning", scanned } });
const start: FlowState = { step: "start", pairing: PAIRING, exclusions: [] };

/** Sends through a throttle every 100 ms, recording what reaches the screens. */
function screens(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const sent: FlowState[] = [];
  return { sent, send: throttleProgress((state) => sent.push(state), 100) };
}

describe("Sending progress to the screens", () => {
  it("sends the first state of a step at once, then at most one state every interval, ending with the latest", (t) => {
    const { sent, send } = screens(t);

    send(comparing(1));
    send(comparing(2));
    send(comparing(3));
    assert.deepEqual(sent, [comparing(1)]);

    t.mock.timers.tick(100);
    assert.deepEqual(sent, [comparing(1), comparing(3)]);
    t.mock.timers.tick(1000);
    assert.deepEqual(sent, [comparing(1), comparing(3)], "nothing sent twice");
  });

  it("sends a new step at once, dropping progress held back from the step before", (t) => {
    const { sent, send } = screens(t);

    send(comparing(1));
    send(comparing(2));
    send(start);
    t.mock.timers.tick(1000);

    assert.deepEqual(sent, [comparing(1), start]);
  });

  it("never holds back a state on a step without progress", (t) => {
    const { sent, send } = screens(t);
    const withError: FlowState = { ...start, error: "Not connected" };

    send(start);
    send(withError);

    assert.deepEqual(sent, [start, withError]);
  });
});
