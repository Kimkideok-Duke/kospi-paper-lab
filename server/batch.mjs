import { END, kst, slotFor, slotTime } from "./engine.mjs";

const MINUTE = 60_000;

export function startBatch(run, report = console.info) {
  let previousSlot = null;
  let timer;
  let stopped = false;

  async function tick() {
    const now = Date.now();
    if (stopped || kst(now).slice(0, 10) >= END) return;
    const slot = slotFor(now);
    try {
      if (slot && slot.id !== previousSlot && now >= slotTime(slot)) {
        const result = await run(now);
        if (result.status !== "error") previousSlot = slot.id;
        if (result.status !== "outside") report(result.message);
      }
    } catch (error) {
      report(error.message);
    } finally {
      if (!stopped) timer = setTimeout(tick, MINUTE - Date.now() % MINUTE).unref();
    }
  }

  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
