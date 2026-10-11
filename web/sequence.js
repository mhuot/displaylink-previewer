// Path-aware sequence lookup and duration/loop-accurate playback.
(function (root) {
  'use strict';

  function normalize(path) {
    const parts = [];
    for (const part of path.replace(/\\/g, '/').toLowerCase().split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return parts.join('/');
  }

  function resolve(entries, slide, sequencePath = '') {
    if (!slide) return { entry: null, error: 'No slide' };
    const requested = normalize(slide.path || slide.name);
    const paths = entries.map(entry => ({ entry, path: normalize(entry.path) }));
    const relative = !/^(?:[a-z]:[\\/]|[\\/])/i.test(slide.path || '');
    const folder = sequencePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    const exactPath = relative ? normalize(folder + '/' + (slide.path || slide.name)) : requested;
    const exact = paths.filter(candidate => candidate.path === exactPath);
    if (exact.length === 1) return { entry: exact[0].entry, error: null };

    // A Windows library prefix may differ from the picked folder's prefix.
    // Prefer the longest shared directory suffix, never arbitrary basename order.
    const parts = requested.split('/');
    for (let length = parts.length; length >= 2; length--) {
      const suffix = parts.slice(-length).join('/');
      const matches = paths.filter(candidate =>
        candidate.path === suffix || candidate.path.endsWith('/' + suffix));
      if (matches.length === 1) return { entry: matches[0].entry, error: null };
      if (matches.length > 1) return { entry: null, error: 'Ambiguous slide: ' + matches.map(m => m.entry.path).join(', ') };
    }
    const name = parts.at(-1);
    const matches = paths.filter(candidate => candidate.path.split('/').at(-1) === name);
    if (matches.length === 1) return { entry: matches[0].entry, error: null };
    return {
      entry: null,
      error: matches.length ? 'Ambiguous slide: ' + matches.map(m => m.entry.path).join(', ') : 'Not in loaded folder',
    };
  }

  function play(items, model, show, onError) {
    let timer = null, stopped = false, index = 0, cycles = 0;
    const stop = () => {
      stopped = true;
      root.clearTimeout(timer);
      timer = null;
    };
    // A forever loop whose slides all last 0s would re-render with no delay.
    const cycleSeconds = items.reduce((sum, item) => sum + (Number.isFinite(item.seconds) ? item.seconds : 0), 0);
    const advance = async () => {
      try {
        if (stopped || !items.length) return;
        await show(index);
        if (stopped) return;
        const seconds = items[index].seconds;
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid slide duration');
        timer = root.setTimeout(() => {
          if (stopped) return;
          if (index === items.length - 1) {
            cycles++;
            if (!model.loopForever && cycles >= model.loops) {
              stop();
              return;
            }
          }
          index = (index + 1) % items.length;
          advance();
        }, seconds * 1000);
      } catch (error) {
        stop();
        onError(error);
      }
    };
    if (!model.loopForever && (!Number.isInteger(model.loops) || model.loops < 1)) {
      stop();
      onError(new Error('Invalid sequence loop count'));
    } else if (model.loopForever && items.length && cycleSeconds <= 0) {
      stop();
      onError(new Error('Sequence loops forever with no slide durations'));
    } else {
      advance();
    }
    return {
      stop,
      get active() { return !stopped; },
    };
  }

  const api = { resolve, play };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DLSequence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
