// MAGIC MOTION — gate A plumbing test.
//
// A sine wave on three channels. Nothing here is generative; the only question this answers is
// whether a MOD can move the model at all. A MOD never touches the model, so the chain is:
//
//   this file  ->  Kokoro.invoke('apply_live2d_pose', { pose })  ->  host emits `live2d-pose`
//              ->  Live2DController.applyPose()                  ->  rig parameters
//
// Poses go out at 30 Hz, the rate a fitted motion model generates at. The host applies only the
// newest frame on its own render frame, so timer throttling in this iframe cannot stall the motion,
// and the controller hands the model back if the stream stops for 400 ms.
(function () {
  var started = false;

  function start() {
    if (started) return;
    if (typeof window.Kokoro === 'undefined' || !window.Kokoro || typeof window.Kokoro.invoke !== 'function') {
      // The bridge is injected by the host; wait for it rather than throwing at load.
      setTimeout(start, 200);
      return;
    }
    started = true;

    var t0 = performance.now();
    var frames = 0;
    var stopped = false;

    function send(pose) {
      try {
        var p = window.Kokoro.invoke('apply_live2d_pose', { pose: pose });
        if (p && typeof p.catch === 'function') p.catch(function () {});
      } catch (e) {
        /* the seam is best-effort: a failing pose must never break the voice mod */
      }
    }

    function tick() {
      if (stopped) return;
      var t = (performance.now() - t0) / 1000;
      send({
        headX: 0.8 * Math.sin(t * (2 * Math.PI) / 3),
        headY: 0.25 * Math.sin(t * (2 * Math.PI) / 5),
        headZ: 0.35 * Math.sin(t * (2 * Math.PI) / 4.2),
        eyeX: 0.6 * Math.sin(t * (2 * Math.PI) / 2.1),
        breath: 0.5 + 0.5 * Math.sin(t * (2 * Math.PI) / 4)
      });
      frames += 1;
    }

    window.__magicGateA = {
      frames: function () { return frames; },
      seconds: function () { return (performance.now() - t0) / 1000; },
      stop: function () {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        send(null); // hand the model back immediately
      }
    };

    var timer = setInterval(tick, 33);
    tick();
    console.log('[magic] gate A sine running (30 Hz)');
  }

  window.addEventListener('beforeunload', function () {
    if (window.__magicGateA) window.__magicGateA.stop();
  });

  start();
})();
