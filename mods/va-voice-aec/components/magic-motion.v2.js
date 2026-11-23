// MAGIC MOTION — generative idle and speaking motion (two references + crossfade).
//
// Two vector autoregressions, both fitted offline to recorded references (ridge 1e-3, 20 lags,
// 30 Hz, the same 13 normalised channels AIRI uses). The MOD generates pose frames and pushes them
// through `apply_live2d_pose`; the app maps them onto the rig. Nothing here touches the model, and
// nothing in the app generates motion - with the mode off this file is inert.
//
// Measured behaviour: the learned dynamics are damped, so the shaped noise is what drives movement.
// `noise` is therefore the real liveliness dial (0.7 default; 0 is a frozen pose). Output is smoothed
// at a=0.8 - unsmoothed it reads as twitching.
//
// Speech: the AEC MOD already owns playback, so it reports `__vaVoice.speaking` and this file
// crossfades between the idle and speaking references on that flag - 1.6 s in, 3.0 s out, the shape
// AIRI uses, because a slow return reads as calming down rather than a snap.
(function () {
  var SAMPLE_MS = 1000 / 30;
  var FADE_IN_MS = 1600;
  var FADE_OUT_MS = 3000;
  // AIRI's output-filter cutoff: the smallest normalised change that is allowed to move a channel.
  // Without it the EMA chases the generator's per-frame noise and the result reads as a tremor -
  // a puppeteer with a shaking hand - because a sub-degree wiggle every 33 ms never settles.
  // 0.0575 normalised is ~1.7 degrees of head at the 30 degree scale.
  var CUTOFF = 0.0575;

  var PROFILES = {
    calm: 'magic/var-idle-calm.json',
    excited: 'magic/var-speaking-excited.json'
  };

  var state = {
    models: {},
    config: {
      enabled: true,
      idleProfile: 'calm',
      speakingProfile: 'excited',
      followSpeech: true,
      noise: 0.7,
      // Amplitude of the finished pose, separate from `noise`. Noise changes how lively the
      // movement is; strength scales what comes out, so a reference that is too big for this rig
      // can be turned down without making it look lazy or frozen.
      strength: 0.7
    },
    speakWeight: 0,
    timer: null,
    nextDue: 0,
    count: 0
  };

  function randomNormal() {
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
      out[i] = sum + 0;
    }
    return out;
  }

  function ensure(key, model) {
    if (state.models[key]) return state.models[key];
    var entry = {
      model: model,
      frames: [],
      smooth: model.intercept.slice(),
      accepted: model.intercept.slice()   // cutoff filter state, per channel
    };
    for (var i = 0; i < model.order; i++) entry.frames.push(model.intercept.slice());
    state.models[key] = entry;
    return entry;
  }

  function step(entry) {
    var model = entry.model;
    var D = model.intercept.length;
    var out = model.intercept.slice();
    for (var lag = 0; lag < model.order; lag++) {
      var contrib = multiply(model.coef[lag], entry.frames[entry.frames.length - 1 - lag]);
      for (var i = 0; i < D; i++) out[i] += contrib[i];
    }
    var z = new Array(D);
    for (var k = 0; k < D; k++) z[k] = randomNormal();
    var noise = multiply(model.noiseCholesky, z);
    for (var n = 0; n < D; n++) {
      out[n] += noise[n] * state.config.noise;
      if (!isFinite(out[n])) out[n] = 0;
      out[n] = Math.max(-1, Math.min(1, out[n]));
    }
    var a = model.smoothingDefault;
    // Two stages, in AIRI's order: a cutoff deadband that refuses sub-threshold changes, then the
    // EMA that eases the accepted target. The EMA alone still tracks the noise, just softer.
    for (var c = 0; c < D; c++) {
      if (Math.abs(out[c] - entry.accepted[c]) >= CUTOFF) entry.accepted[c] = out[c];
    }
    for (var s = 0; s < D; s++) {
      entry.smooth[s] = a * entry.smooth[s] + (1 - a) * entry.accepted[s];
    }
    entry.frames.push(out);
    if (entry.frames.length > model.order) entry.frames.shift();
    return entry.smooth;
  }

  function speakingNow() {
    if (!state.config.followSpeech) return false;
    try {
      var voice = window.__vaVoice;
      if (!voice) return false;
      if (typeof voice.speaking === 'boolean') return voice.speaking;
      if (typeof voice.lastPlaybackEnd === 'number') return performance.now() < voice.lastPlaybackEnd;
    } catch (e) { /* never let speech detection break the loop */ }
    return false;
  }

  function send(pose) {
    try {
      var p = window.Kokoro.invoke('apply_live2d_pose', { pose: pose });
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* a failing pose must never break the voice loop */ }
  }

  function tick() {
    if (!state.config.enabled) return;
    var idleEntry = state.models[state.config.idleProfile];
    if (!idleEntry) return;
    var speakEntry = state.models[state.config.speakingProfile];

    // One generator, one advance. When the idle and speaking profiles are the same profile the two
    // entries are the SAME object, so stepping both would run that model at 60 Hz and inject twice
    // the noise per second - measured as ~2x the reference amplitude (std 12.2 deg against AIRI's
    // 7.2 on the same recording).
    var sameEntry = speakEntry === idleEntry;
    var idle = step(idleEntry);
    var speaking = sameEntry ? idle : step(speakEntry);

    var target = speakingNow() ? 1 : 0;
    var ms = target > state.speakWeight ? FADE_IN_MS : FADE_OUT_MS;
    var amount = SAMPLE_MS / ms;
    state.speakWeight = target > state.speakWeight
      ? Math.min(target, state.speakWeight + amount)
      : Math.max(target, state.speakWeight - amount);

    var w = state.speakWeight;
    var axes = idleEntry.model.axes;
    var scale = state.config.strength;
    var get = function (name) {
      var idx = axes.indexOf(name);
      if (idx < 0) return 0;
      var blended = idle[idx] * (1 - w) + speaking[idx] * w;
      return Math.max(-1, Math.min(1, blended * scale));
    };

    send({
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
    });
    state.count += 1;
  }

  function schedule() {
    var now = performance.now();
    if (!state.nextDue) state.nextDue = now;
    state.nextDue += SAMPLE_MS;
    if (state.nextDue < now) state.nextDue = now + SAMPLE_MS;
    state.timer = setTimeout(function () { tick(); schedule(); }, Math.max(0, state.nextDue - now));
  }

  function start() {
    if (state.timer) return;
    state.nextDue = 0;
    schedule();
  }

  function stop() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    send(null);
  }

  var loading = {};
  function loadProfile(key) {
    if (state.models[key]) return Promise.resolve();
    if (loading[key]) return loading[key];
    loading[key] = fetch(PROFILES[key])
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (model) { ensure(key, model); })
      .catch(function (e) {
        console.error('[magic] could not load ' + key + ':', e && e.message ? e.message : e);
      });
    return loading[key];
  }

  function applyConfig(next) {
    if (!next || typeof next !== 'object') return;
    if (typeof next.enabled === 'boolean') state.config.enabled = next.enabled;
    if (typeof next.followSpeech === 'boolean') state.config.followSpeech = next.followSpeech;
    if (typeof next.noise === 'number' && isFinite(next.noise)) {
      state.config.noise = Math.max(0, Math.min(1.5, next.noise));
    }
    if (typeof next.strength === 'number' && isFinite(next.strength)) {
      state.config.strength = Math.max(0, Math.min(2, next.strength));
    }
    if (typeof next.idleProfile === 'string' && PROFILES[next.idleProfile]) {
      state.config.idleProfile = next.idleProfile;
    }
    if (typeof next.speakingProfile === 'string' && PROFILES[next.speakingProfile]) {
      state.config.speakingProfile = next.speakingProfile;
    }

    if (!state.config.enabled) { send(null); return; }
    if (!state.models[state.config.idleProfile]) loadProfile(state.config.idleProfile).then(start);
    else start();
    loadProfile(state.config.speakingProfile);
  }

  window.__magicMotion = {
    frames: function () { return state.count; },
    start: start,
    stop: stop,
    setConfig: applyConfig,
    setNoise: function (v) { applyConfig({ noise: Number(v) }); },
    setEnabled: function (v) { applyConfig({ enabled: !!v }); },
    status: function () {
      return {
        loaded: Object.keys(state.models),
        running: !!state.timer,
        frames: state.count,
        noise: state.config.noise,
        speakWeight: +state.speakWeight.toFixed(2),
        config: state.config
      };
    }
  };

  function boot() {
    if (typeof window.Kokoro === 'undefined' || !window.Kokoro || typeof window.Kokoro.invoke !== 'function') {
      setTimeout(boot, 200);
      return;
    }
    if (typeof window.Kokoro.on === 'function') window.Kokoro.on('magic', applyConfig);
    loadProfile(state.config.idleProfile).then(function () {
      loadProfile(state.config.speakingProfile);
      start();
    });
  }

  window.addEventListener('beforeunload', stop);
  boot();
})();
