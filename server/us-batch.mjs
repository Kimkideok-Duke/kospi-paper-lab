import { END, usDate } from "./us-engine.mjs";
export function startUsBatch(run, report = console.info) {
  let stopped = false, timer;
  async function tick() {
    if (stopped || usDate(Date.now()) >= END) return;
    try {
      const result = await run(Date.now());
      if (!["outside", "duplicate", "waiting"].includes(result.status)) report(result.message);
    } catch (error) { report(error.message); }
    finally { if (!stopped) timer = setTimeout(tick, 60_000 - Date.now() % 60_000).unref(); }
  }
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
