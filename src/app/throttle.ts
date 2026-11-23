import type { FlowState } from "./view.ts";

/** The steps whose state changes with every bit of progress. */
const WITH_PROGRESS: ReadonlySet<FlowState["step"]> = new Set(["comparing", "updating"]);

/**
 * Wraps `send` so that a stream of progress reaches the screens at most once every `ms`. A state on
 * a new step, or on a step without progress, goes at once. While the step stays Comparing or
 * Updating, states arriving within `ms` of the last one sent are held back, and only the latest is
 * sent when the interval ends, so the screens always end up with the latest state.
 */
export function throttleProgress(send: (state: FlowState) => void, ms: number): (state: FlowState) => void {
  let lastStep: FlowState["step"] | undefined;
  let lastSentAt = -Infinity;
  let held: FlowState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sendNow = (state: FlowState) => {
    clearTimeout(timer);
    timer = undefined;
    held = undefined;
    lastStep = state.step;
    lastSentAt = Date.now();
    send(state);
  };
  return (state) => {
    const sinceLast = Date.now() - lastSentAt;
    if (state.step !== lastStep || !WITH_PROGRESS.has(state.step) || sinceLast >= ms) return sendNow(state);
    held = state;
    timer ??= setTimeout(() => {
      if (held !== undefined) sendNow(held);
    }, ms - sinceLast);
  };
}
