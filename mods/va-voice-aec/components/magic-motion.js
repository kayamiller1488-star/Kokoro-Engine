// MAGIC MOTION — generative idle, VAR fitted to a recorded reference.
//
// The maths is a vector autoregression: each 30 Hz frame is predicted from the previous 20
// frames, plus Gaussian noise shaped by the residual covariance, then smoothed. The coefficients
// in magic/var-idle-calm.json were fitted offline (ridge 1e-3) to a 62.6 s recording, so nothing
// expensive happens at runtime and the frame cost is 3393 multiply-adds — microseconds.
//
// Measured on this rig's semantics (30 degrees head, 10 body, matching AIRI's own mapping):
//   noise 0.7 -> head std 0.26, p95 +/-16°, roughness 0.056 vs the recording's 0.046
//   noise 0.0 -> std 0.048: the learned dynamics are damped, the noise is what drives the motion
// so `liveliness` is the real dial, and 0.7 is the default.
//
// The MOD never touches the model: it emits normalised poses through `apply_live2d_pose` and the
// app maps them onto the rig. Channels the rig lacks are skipped there, so torso values are
// simply unused on our models.
(function () {
  var SAMPLE_MS = 1000 / 30;
  var state = {
    model: null,
    frames: [],          // rolling window of generated frames (13 values each)
    smooth: null,        // smoothed output, same length as a frame
    timer: null,
    nextDue: 0,
    startedAt: 0,
    count: 0,
    noiseScale: 0.7,
    smoothing: 0.8,
    enabled: true
  };

  function randomNormal() {
    // Box-Muller. Math.random is not cryptographic here and does not need to be.
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function multiply(matrix, vector) {
    var out = new Array(matrix.length);
    for (var i = 0; i < matrix.length; i++) {
      var row = matrix[i], sum = 0;
      for (var j = 0; j < vector.length; j++) sum += row[j] * vector[j];
      out[i] = sum + 0; // avoid -0 leaking into the pose
    }
    return out;
  }

  function nextFrame(model) {
    var D = model.intercept.length;
    var out = model.intercept.slice();
    for (var lag = 0; lag < model.order; lag++) {
      var frame = state.frames[state.frames.length - 1 - lag];
      var contrib = multiply(model.coef[lag], frame);
      for (var i = 0; i < D; i++) out[i] += contrib[i];
    }
    var noise = multiply(model.noiseCholesky, (function () {
      var z = new Array(D);
      for (var i = 0; i < D; i++) z[i] = randomNormal();
      return z;
    })());
    for (var k = 0; k < D; k++) out[k] += noise[k] * state.noiseScale;

    // Keep the state inside the range the seam accepts; a runaway frame would otherwise be
    // clamped per channel at the model and desynchronise the rolling window.
    for (var c = 0; c < D; c++) {
      if (!isFinite(out[c])) out[c] = 0;
      out[c] = Math.max(-1, Math.min(1, out[c]));
    }

    // AIRI's output smoothing: the noise is white, and unsmoothed it reads as twitching.
    if (!state.smooth) state.smooth = out.slice();
    var a = state.smoothing;
    for (var s = 0; s < D; s++) state.smooth[s] = a * state.smooth[s] + (1 - a) * out[s];

    state.frames.push(out);
    if (state.frames.length > model.order) state.frames.shift();
    state.count += 1;
    return state.smooth;
  }

  function toPose(model, values) {
    var ax = model.axes;
    var get = function (name) { return values[ax.indexOf(name)] || 0; };
    return {
      headX: get('headX'),
      headY: get('headY'),
      headZ: get('headZ'),
      bodyX: get('bodyX'),
      bodyY: get('bodyY'),
      bodyZ: get('bodyZ'),
      eyeX: get('eyeX'),
      eyeY: get('eyeY'),
      eyeSquint: get('eyeSquint'),
      mouthForm: get('mouthForm')
    };
  }

  function send(pose) {
    try {
      var p = window.Kokoro.invoke('apply_live2d_pose', { pose: pose });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* never let a pose break the voice loop */ }
  }

  function tick() {
    if (!state.enabled || !state.model) return;
    send(toPose(state.model, nextFrame(state.model)));
  }

  function seedFromNeutral(model) {
    // Start from the model's own intercept so the first generated frames are near rest rather
    // than a jump out of the current pose.
    var frame = model.intercept.slice();
    state.frames = [];
    for (var i = 0; i < model.order; i++) state.frames.push(frame.slice());
    state.smooth = model.intercept.slice();
  }

  function start() {
    if (state.timer) return;
    state.startedAt = performance.now();
    state.count = 0;
    state.nextDue = 0;
    schedule();
    console.log('[magic] VAR idle running: order ' + state.model.order + ', noise ' + state.noiseScale);
  }

  // Self-correcting schedule instead of setInterval. A plain interval accumulates drift and, after a
  // throttled tick, fires several timers back to back, which reaches the app as uneven frame
  // spacing - visible as the motion speeding up and slowing down. This targets absolute times and
  // resynchronises (rather than bursting) when it falls behind.
  function schedule() {
    var now = performance.now();
    if (!state.nextDue) state.nextDue = now;
    state.nextDue += SAMPLE_MS;
    if (state.nextDue < now) state.nextDue = now + SAMPLE_MS;
    state.timer = setTimeout(function () {
      tick();
      schedule();
    }, Math.max(0, state.nextDue - now));
  }

  function stop() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    send(null); // hand the model back
  }

  window.__magicMotion = {
    frames: function () { return state.count; },
    stop: stop,
    start: start,
    setNoise: function (v) { state.noiseScale = Math.max(0, Math.min(1.5, Number(v) || 0)); },
    setEnabled: function (v) { state.enabled = !!v; if (!v) send(null); },
    status: function () {
      return { loaded: !!state.model, running: !!state.timer, frames: state.count, noise: state.noiseScale };
    }
  };

  function boot() {
    if (typeof window.Kokoro === 'undefined' || !window.Kokoro || typeof window.Kokoro.invoke !== 'function') {
      setTimeout(boot, 200);
      return;
    }
    fetch('magic/var-idle-calm.json')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (model) {
        state.model = model;
        state.noiseScale = typeof model.noiseScaleDefault === 'number' ? model.noiseScaleDefault : 0.7;
        state.smoothing = typeof model.smoothingDefault === 'number' ? model.smoothingDefault : 0.8;
        seedFromNeutral(model);
        start();
      })
      .catch(function (e) {
        console.error('[magic] could not load the fitted model:', e && e.message ? e.message : e);
      });
  }

  window.addEventListener('beforeunload', stop);
  boot();
})();
