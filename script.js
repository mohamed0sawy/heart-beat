/* ============================================================
   سر صغير — script.js
   A small tap-driven finite state machine. Each scene is its
   own function. The chest's on-screen position is computed live
   (object-fit: cover math) so the zoom, vignette, glow and heart
   all stay glued to the same physical point on the photo no
   matter the device's screen shape.
   ============================================================ */

(() => {
  'use strict';

  /* ---------- normalized focal point on the ORIGINAL photo ----------
     (0,0) = top-left of the photo, (1,1) = bottom-right.
     This was measured directly on the source image: it sits on
     his chest/sternum. */
  const FOCAL = { x: 0.68, y: 0.37 };

  const BEAT_DURATION = 1300; // ms between heartbeats — slow & gentle
  const NAME_LETTERS  = ['م', 'مر', 'مري', 'مريم'];

  const STEPS = [
    null, // index 0: the intro itself, not a tap response
    { scale: 1.3, darken: 0,    vignette: 0, text: 'تعالي نقرب شوية...' },
    { scale: 1.8, darken: 0.35, vignette: 0, text: 'لسه السر مستخبي...' },
    { scale: 2.6, darken: 0,    vignette: 1, text: 'اسمعي كويس...'      },
    { scale: 3.5, darken: 0,    vignette: 1, text: null                }
  ];

  /* ---------- DOM refs ---------- */
  const stage           = document.getElementById('stage');
  const curtain         = document.getElementById('curtain');
  const photo            = document.getElementById('photo');
  const photoFrame       = document.getElementById('photo-frame');
  const darkenOverlay    = document.getElementById('darken-overlay');
  const vignetteOverlay  = document.getElementById('vignette-overlay');
  const glowOverlay      = document.getElementById('glow-overlay');
  const narrationText    = document.getElementById('narration-text');
  const tapHint          = document.getElementById('tap-hint');
  const heartWrap        = document.getElementById('heart-wrap');
  const heartImg         = document.getElementById('heart-img');
  const heartName        = document.getElementById('heart-name');
  const finalLine1       = document.getElementById('final-line-1');
  const finalLine2       = document.getElementById('final-line-2');

  /* ---------- tiny helpers ---------- */
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function waitTransitionEnd(el, prop, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      function handler(e) {
        if (e.target === el && e.propertyName === prop) {
          done = true;
          el.removeEventListener('transitionend', handler);
          resolve();
        }
      }
      el.addEventListener('transitionend', handler);
      setTimeout(() => {
        if (!done) {
          el.removeEventListener('transitionend', handler);
          resolve();
        }
      }, timeoutMs);
    });
  }

  /* ============================================================
     Focal point tracking (object-fit: cover math)
     Keeps --ox / --oy glued to the physical chest position in
     the photo regardless of viewport aspect ratio.
     ============================================================ */
  function updateFocalPoint() {
    const cw = photoFrame.clientWidth;
    const ch = photoFrame.clientHeight;
    const iw = photo.naturalWidth;
    const ih = photo.naturalHeight;
    if (!cw || !ch || !iw || !ih) return;

    const containerAspect = cw / ch;
    const imageAspect = iw / ih;
    let originXpct, originYpct;

    if (imageAspect > containerAspect) {
      // image is proportionally wider than the screen -> height matches,
      // left/right edges are cropped
      const scale = ch / ih;
      const renderedW = iw * scale;
      const offsetX = (renderedW - cw) / 2;
      originXpct = ((FOCAL.x * renderedW - offsetX) / cw) * 100;
      originYpct = FOCAL.y * 100;
    } else {
      // image is proportionally taller than the screen -> width matches,
      // top/bottom edges are cropped
      const scale = cw / iw;
      const renderedH = ih * scale;
      const offsetY = (renderedH - ch) / 2;
      originYpct = ((FOCAL.y * renderedH - offsetY) / ch) * 100;
      originXpct = FOCAL.x * 100;
    }

    originXpct = Math.max(4, Math.min(96, originXpct));
    originYpct = Math.max(4, Math.min(96, originYpct));

    document.documentElement.style.setProperty('--ox', originXpct.toFixed(2) + '%');
    document.documentElement.style.setProperty('--oy', originYpct.toFixed(2) + '%');
  }

  /* ============================================================
     Audio — a soft procedural "lub-dub" heartbeat, synthesized
     with the Web Audio API. No audio asset needed.
     ============================================================ */
  let audioCtx = null;

  function ensureAudioContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  }

  function playPulse(baseTime, offset, volume, freq) {
    const t0 = baseTime + offset;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freq * 0.6, 20), t0 + 0.18);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.25);
  }

  function playThump(volume) {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    playPulse(now, 0.0, volume, 62);         // "lub"
    playPulse(now, 0.19, volume * 0.7, 78);  // "dub"
  }

  /* ============================================================
     Heartbeat clock — one continuous, self-scheduling loop.
     Starts quietly (audio only) after tap 3, then — once the
     heart becomes visible after tap 4 — also drives the visual
     pulse, the glow and the letter-by-letter name reveal.
     ============================================================ */
  let heartRevealed = false;
  let heartBeatsSinceReveal = 0;
  let beatTimer = null;
  const GLOW_BASE = 0.55;

  function pulseHeart() {
    heartImg.animate(
      [
        { transform: 'scale(1)' },
        { transform: 'scale(1.14)' },
        { transform: 'scale(0.98)' },
        { transform: 'scale(1.08)' },
        { transform: 'scale(1)' }
      ],
      { duration: BEAT_DURATION * 0.72, easing: 'ease-in-out' }
    );

    glowOverlay.animate(
      [
        { opacity: GLOW_BASE },
        { opacity: Math.min(GLOW_BASE + 0.35, 1) },
        { opacity: GLOW_BASE }
      ],
      { duration: BEAT_DURATION * 0.8, easing: 'ease-in-out' }
    );
  }

  function fadeSwapText(el, text) {
    el.classList.remove('visible');
    setTimeout(() => {
      el.textContent = text;
      if (text !== '') {
        requestAnimationFrame(() => el.classList.add('visible'));
      }
    }, 350);
  }

  function applyNameBeat(idx) {
    const cyclePos = idx % 7; // 4 reveal beats + 2 "stay" beats + 1 fade-away beat
    if (cyclePos <= 3) {
      fadeSwapText(heartName, NAME_LETTERS[cyclePos]);
    } else if (cyclePos === 6) {
      fadeSwapText(heartName, '');
    }
    // cyclePos 4 and 5: hold, no change — the name simply keeps glowing
  }

  function startHeartbeatClock() {
    function tick() {
      playThump(heartRevealed ? 0.96 : 0.09);
      if (heartRevealed) {
        pulseHeart();
        applyNameBeat(heartBeatsSinceReveal);
        heartBeatsSinceReveal++;
      }
      beatTimer = setTimeout(tick, BEAT_DURATION);
    }
    tick();
  }

  /* ============================================================
     Typewriter for the final message
     ============================================================ */
  function typeText(el, text, speed) {
    return new Promise((resolve) => {
      el.textContent = '';
      const caret = document.createElement('span');
      caret.className = 'caret';
      el.appendChild(caret);
      let i = 0;
      const timer = setInterval(() => {
        if (i < text.length) {
          caret.insertAdjacentText('beforebegin', text[i]);
          i++;
        } else {
          clearInterval(timer);
          caret.remove();
          resolve();
        }
      }, speed);
    });
  }

  async function playFinalMessage() {
    await typeText(finalLine1, 'من يوم ما دخلتي حياتي...', 60);
    await wait(1000);
    await typeText(finalLine2, 'بقيتي أقرب حاجة لقلبي', 60);
  }

  /* ============================================================
     Narration swap
     ============================================================ */
  function swapNarration(text) {
    return new Promise((resolve) => {
      narrationText.classList.remove('visible');
      setTimeout(() => {
        narrationText.textContent = text || '';
        if (text) {
          requestAnimationFrame(() => {
            narrationText.classList.add('visible');
            resolve();
          });
        } else {
          resolve();
        }
      }, 550);
    });
  }

  /* ============================================================
     Scene 4 — the heart reveal choreography
     ============================================================ */
  async function sceneHeartReveal() {
    // warm light rising from within the chest
    glowOverlay.style.opacity = String(GLOW_BASE);
    await wait(1500);

    // the heart itself, floating gently above the chest
    heartWrap.classList.add('visible');
    heartRevealed = true;
    heartBeatsSinceReveal = 0;

    await wait(2200);

    // the emotional line, typed out a little while after the heart settles
    await wait(5200);
    await playFinalMessage();
  }

  /* ============================================================
     Core state machine
     ============================================================ */
  const state = { current: 0, animating: false };

  async function goToStep(n) {
    state.animating = true;
    const cfg = STEPS[n];

    if (n === 1) {
      tapHint.classList.remove('visible');
    }

    if (cfg.text !== null) {
      await swapNarration(cfg.text);
    } else {
      narrationText.classList.remove('visible');
    }

    darkenOverlay.style.opacity = String(cfg.darken);
    vignetteOverlay.style.opacity = String(cfg.vignette);
    photo.style.transform = `scale(${cfg.scale})`;

    await waitTransitionEnd(photo, 'transform', 1700);
    state.current = n;

    if (n === 3) {
      ensureAudioContext();
      startHeartbeatClock(); // quiet at first — the heart isn't visible yet
      state.animating = false;
    } else if (n === 4) {
      await sceneHeartReveal();
      state.animating = false;
    } else {
      state.animating = false;
    }
  }

  function onAdvance() {
    ensureAudioContext(); // unlock audio on this real user gesture
    if (state.animating) return;
    if (state.current >= 4) return;
    goToStep(state.current + 1);
  }

  /* ============================================================
     Intro sequence
     ============================================================ */
  async function init() {
    updateFocalPoint();
    window.addEventListener('resize', debounce(updateFocalPoint, 150));
    window.addEventListener('orientationchange', () => setTimeout(updateFocalPoint, 200));

    if (photo.complete && photo.naturalWidth) {
      updateFocalPoint();
    } else {
      photo.addEventListener('load', updateFocalPoint, { once: true });
    }

    await wait(300);
    curtain.classList.add('lifted');
    photo.classList.add('visible');

    await wait(1900); // let the photo settle in
    await wait(1000); // "nothing moves for about one second"

    narrationText.textContent = 'في حاجة جوايا... عايزك تشوفيها بنفسك.';
    requestAnimationFrame(() => narrationText.classList.add('visible'));
    tapHint.classList.add('visible');

    stage.addEventListener('click', onAdvance);
    stage.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onAdvance();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
