const ease = t => t * t * (3 - 2 * t);

// A single cancellable clock. A new target starts at the current position, so
// rapid reversals never reset geometry, queue animations, or accumulate drift.
export function createTransition({ initial = 0, duration = 1400, onUpdate,
  now = () => performance.now(), requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame }) {
  let value = initial, target = initial, animation, frame;
  function sample(time) {
    if (!animation) return value;
    const t = Math.max(0, Math.min(1, (time - animation.start) / animation.duration));
    value = t === 1 ? target : animation.from + (target - animation.from) * ease(t);
    if (t === 1) animation = undefined;
    return value;
  }
  function tick(time) {
    frame = undefined;
    onUpdate(sample(time));
    if (animation) frame = requestFrame(tick);
  }
  function finish() {
    cancelFrame(frame);
    frame = undefined;
    animation = undefined;
    value = target;
    onUpdate(value);
  }
  return {
    get value() { return value; },
    get active() { return Boolean(animation); },
    finish,
    setTarget(next, { immediate = false } = {}) {
      if (next !== 0 && next !== 1) throw new Error('View target must be 0 or 1.');
      const time = now();
      sample(time);
      cancelFrame(frame);
      target = next;
      if (immediate || value === target) return finish();
      animation = { from: value, start: time, duration: duration * Math.abs(target - value) };
      onUpdate(value);
      frame = requestFrame(tick);
    },
  };
}
