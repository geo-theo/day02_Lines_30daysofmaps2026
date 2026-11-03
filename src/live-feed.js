import { decodeFeed } from './gtfs-realtime.js';

// One request at a time. Schedule AFTER completion, pause in background tabs,
// and back off on errors without shortening the configured refresh interval.
export function createLiveFeed({ url, config, onChange, fetcher = fetch,
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout,
  visibility = document }) {
  let timer, controller, stopped = true, running = false, failures = 0, earliest = 0;
  const refreshMs = Math.max(30_000, config.refreshMs);
  const maxRetryMs = Math.max(300_000, refreshMs);
  let state = { phase: 'loading', vehicles: [], timestamp: undefined, receivedAt: undefined };
  function emit() { onChange({ ...state }); }
  function schedule() {
    clearTimer(timer);
    if (!stopped && !visibility.hidden) timer = setTimer(refresh, Math.max(0, earliest - now()));
  }
  async function refresh() {
    if (stopped || running || visibility.hidden) return;
    if (now() < earliest) return schedule();
    running = true;
    controller = new AbortController();
    const timeout = setTimer(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetcher(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('Content-Length')) > 2_000_000) throw new Error('Oversized vehicle feed');
      const feed = decodeFeed(await response.arrayBuffer(), response.headers.get('Content-Type') ?? '');
      if (feed.timestamp && state.timestamp && feed.timestamp < state.timestamp) throw new Error('Feed timestamp moved backwards');
      const previous = new Map(state.vehicles.map(v => [v.id, v]));
      const receivedAt = now() / 1000;
      const vehicles = feed.vehicles.map(vehicle => {
        const old = previous.get(vehicle.id);
        if (old?.timestamp && vehicle.timestamp && vehicle.timestamp < old.timestamp) return old;
        const unchanged = old && vehicle.longitude === old.longitude && vehicle.latitude === old.latitude;
        return { ...vehicle, firstReceivedAt: unchanged ? old.firstReceivedAt : receivedAt };
      });
      state = { phase: 'ready', ...feed, vehicles, receivedAt, error: undefined };
      failures = 0;
    } catch (error) {
      if (stopped) return;
      failures++;
      state = { ...state, phase: 'error', error: error.name === 'AbortError' ? 'Request timed out' : error.message };
    } finally {
      clearTimer(timeout);
      running = false;
      earliest = now() + Math.min(maxRetryMs, refreshMs * 2 ** Math.min(failures, 4));
      if (!stopped) { emit(); schedule(); }
    }
  }
  function visibilityChanged() { clearTimer(timer); if (!visibility.hidden) schedule(); }
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      visibility.addEventListener('visibilitychange', visibilityChanged);
      emit(); schedule();
    },
    stop() { stopped = true; clearTimer(timer); controller?.abort(); visibility.removeEventListener('visibilitychange', visibilityChanged); },
  };
}
