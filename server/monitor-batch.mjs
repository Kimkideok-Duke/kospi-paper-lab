export const MONITOR_INTERVAL_MS = 5000;
export function monitorStatus(results) {
  return { status: results.some(r => r?.status === 'error') ? 'error' : results.some(r => r?.status === 'ok') ? 'ok' : 'outside' };
}
export function startMonitorBatch(run, heartbeat = () => {}, report = console.info) {
  let stopped = false, timer, errors = 0;
  async function tick() {
    if (stopped) return;
    heartbeat(Date.now());
    try { const result = await run(Date.now()); errors = result?.status === 'error' ? errors + 1 : 0; }
    catch (error) { errors++; report(error.message); }
    finally {
      // Await completion; skip missed slots and never overlap or catch up in a burst.
      const delay = errors ? Math.min(60000, MONITOR_INTERVAL_MS * 2 ** Math.min(errors, 4)) : MONITOR_INTERVAL_MS - Date.now() % MONITOR_INTERVAL_MS;
      if (!stopped) timer = setTimeout(tick, delay).unref();
    }
  }
  timer = setTimeout(tick, MONITOR_INTERVAL_MS).unref();
  return () => { stopped = true; clearTimeout(timer); };
}
