export function startMonitorBatch(run, heartbeat = () => {}, report = console.info) {
  let stopped = false, timer;
  async function tick() {
    if (stopped) return;
    heartbeat(Date.now());
    try { await run(Date.now()); } catch (error) { report(error.message); }
    finally { if (!stopped) timer = setTimeout(tick, (30_000 - Date.now() % 60_000 + 60_000) % 60_000 || 60_000).unref(); }
  }
  timer = setTimeout(tick, 5000).unref();
  return () => { stopped = true; clearTimeout(timer); };
}
