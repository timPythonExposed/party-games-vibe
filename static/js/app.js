/* ===== Hints app – client-side JS ===== */

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  LS.set('hints.theme', theme);
}

(function initTheme() {
  const saved = LS.get('hints.theme', 'dark');
  applyTheme(saved);
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const current = LS.get('hints.theme', 'dark');
      const next = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
      applyTheme(next);
    });
  }
})();

// Text scale
(function initTextScale() {
  const saved = LS.get('hints.textScale', 'normal');
  document.documentElement.setAttribute('data-text-scale', saved);
})();

// ---------------------------------------------------------------------------
// Timer class
// ---------------------------------------------------------------------------
class Timer {
  constructor(durationSec, onTick, onDone) {
    this.duration = durationSec;
    this.remaining = durationSec;
    this.onTick = onTick;
    this.onDone = onDone;
    this._raf = null;
    this._start = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._start = performance.now() - (this.duration - this.remaining) * 1000;
    this._tick();
  }

  _tick() {
    if (!this._running) return;
    const elapsed = (performance.now() - this._start) / 1000;
    this.remaining = Math.max(0, this.duration - elapsed);
    this.onTick(this.remaining, this.duration);
    if (this.remaining <= 0) {
      this._running = false;
      this.onDone();
      return;
    }
    this._raf = requestAnimationFrame(() => this._tick());
  }

  pause() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  reset(newDuration) {
    this.pause();
    if (newDuration !== undefined) this.duration = newDuration;
    this.remaining = this.duration;
    this.onTick(this.remaining, this.duration);
  }
}

// ---------------------------------------------------------------------------
// Time-up sound – loud "sad trombone" wah-wah-wah-wahhh
// ---------------------------------------------------------------------------
function playTimeUpSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Compressor to maximize perceived loudness without clipping
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 10;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.1;
    compressor.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = 1.0;
    master.connect(compressor);

    // Sad trombone: Bb4 -> A4 -> Ab4 -> G4 (long slide down)
    const notes = [
      { freq: 466, start: 0,    dur: 0.35 },
      { freq: 440, start: 0.4,  dur: 0.35 },
      { freq: 415, start: 0.8,  dur: 0.35 },
      { freq: 392, start: 1.2,  dur: 0.8  },
    ];

    notes.forEach(({ freq, start, dur }) => {
      // Main tone (sawtooth for brassy timbre)
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      // Slide the last note down for comedic droop
      if (dur > 0.5) {
        osc.frequency.linearRampToValueAtTime(freq * 0.85, ctx.currentTime + start + dur);
      }

      // Second oscillator, slightly detuned, for fatness
      const osc2 = ctx.createOscillator();
      osc2.type = 'sawtooth';
      osc2.frequency.setValueAtTime(freq * 1.005, ctx.currentTime + start);
      if (dur > 0.5) {
        osc2.frequency.linearRampToValueAtTime(freq * 0.85 * 1.005, ctx.currentTime + start + dur);
      }

      // Vibrato (wobble) for trombone "wah" feel
      const vibrato = ctx.createOscillator();
      const vibratoGain = ctx.createGain();
      vibrato.frequency.value = 6;
      vibratoGain.gain.value = freq * 0.025;
      vibrato.connect(vibratoGain);
      vibratoGain.connect(osc.frequency);
      vibratoGain.connect(osc2.frequency);
      vibrato.start(ctx.currentTime + start);
      vibrato.stop(ctx.currentTime + start + dur + 0.1);

      // Envelope
      const g = ctx.createGain();
      g.gain.setValueAtTime(1.0, ctx.currentTime + start);
      g.gain.setValueAtTime(1.0, ctx.currentTime + start + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + start + dur);

      osc.connect(g);
      osc2.connect(g);
      g.connect(master);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur + 0.05);
      osc2.start(ctx.currentTime + start);
      osc2.stop(ctx.currentTime + start + dur + 0.05);
    });
  } catch {}
}

// ---------------------------------------------------------------------------
// Play page initialisation
// ---------------------------------------------------------------------------
function initPlay() {
  const timerBar     = document.getElementById('timerBar');
  const timerDisplay = document.getElementById('timerDisplay');
  const wordEl       = document.getElementById('word');
  const nextBtn      = document.getElementById('nextBtn');
  const resetTimerBtn= document.getElementById('resetTimerBtn');
  const timeUpOverlay= document.getElementById('timeUpOverlay');
  const emptyOverlay = document.getElementById('emptyOverlay');
  const overlayNextBtn  = document.getElementById('overlayNextBtn');
  const overlayCloseBtn = document.getElementById('overlayCloseBtn');
  const emptyResetBtn   = document.getElementById('emptyResetBtn');
  const toast        = document.getElementById('toast');
  const categoryBadge = document.getElementById('categoryBadge');

  const timerSec = LS.get('hints.timerSeconds', 60);
  const noTimer = timerSec === 0;

  // Hide timer UI when timer is disabled
  if (noTimer) {
    timerBar.parentElement.hidden = true;
    timerDisplay.hidden = true;
    resetTimerBtn.hidden = true;
  }

  function onTick(remaining, total) {
    if (noTimer) return;
    const secs = Math.ceil(remaining);
    timerDisplay.textContent = secs;
    const pct = remaining / total;
    timerBar.style.width = (pct * 100) + '%';
    timerBar.classList.toggle('warning', pct <= 0.3 && pct > 0.1);
    timerBar.classList.toggle('danger', pct <= 0.1);
    // Timer display color classes
    timerDisplay.classList.toggle('timer-warning', pct <= 0.3 && pct > 0.1);
    timerDisplay.classList.toggle('timer-danger', pct <= 0.1);
  }

  function onDone() {
    if (noTimer) return;
    playTimeUpSound();
    try { navigator.vibrate([300, 100, 300, 100, 500]); } catch {}
    timeUpOverlay.hidden = false;
  }

  const timer = noTimer ? null : new Timer(timerSec, onTick, onDone);
  if (!noTimer) onTick(timerSec, timerSec);   // initial render

  // -- Fetch next word --
  async function fetchNext() {
    try {
      const res = await fetch('/next', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 204) {
        emptyOverlay.hidden = false;
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij ophalen woord');
        return;
      }
      const data = await res.json();
      wordEl.textContent = data.word;
      wordEl.classList.remove('fade-in');
      // trigger reflow for re-animation
      void wordEl.offsetWidth;
      wordEl.classList.add('fade-in');

      // Show category badge for Pictionary
      if (data.category && categoryBadge) {
        categoryBadge.textContent = data.category;
        categoryBadge.style.backgroundColor = data.category_color || '#4F46E5';
        categoryBadge.hidden = false;
      } else if (categoryBadge) {
        categoryBadge.hidden = true;
      }

      if (timer) {
        timer.reset(LS.get('hints.timerSeconds', 60));
        timer.start();
      }
      timeUpOverlay.hidden = true;
    } catch (err) {
      showToast('Netwerkfout');
    }
  }

  // -- Reset words --
  async function resetWords() {
    try {
      await fetch('/reset_used', { method: 'POST', credentials: 'same-origin' });
      emptyOverlay.hidden = true;
      showToast('Woorden gereset');
    } catch {}
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  // -- Event listeners --
  nextBtn.addEventListener('click', fetchNext);
  resetTimerBtn.addEventListener('click', () => {
    if (timer) {
      timer.reset(LS.get('hints.timerSeconds', 60));
      onTick(timer.remaining, timer.duration);
    }
    timeUpOverlay.hidden = true;
  });
  overlayNextBtn.addEventListener('click', fetchNext);
  overlayCloseBtn.addEventListener('click', () => { timeUpOverlay.hidden = true; });
  emptyResetBtn.addEventListener('click', async () => {
    await resetWords();
    fetchNext();
  });

  // -- Shake to next (mobile) --
  let lastShake = 0;
  window.addEventListener('devicemotion', (e) => {
    const acc = e.accelerationIncludingGravity;
    if (!acc) return;
    const force = Math.abs(acc.x) + Math.abs(acc.y) + Math.abs(acc.z);
    if (force > 35 && Date.now() - lastShake > 1000) {
      lastShake = Date.now();
      fetchNext();
    }
  });

  // -- Fullscreen toggle (double-tap on word) --
  let lastTap = 0;
  wordEl.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 300) {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    }
    lastTap = now;
  });
}

// ---------------------------------------------------------------------------
// Settings page initialisation
// ---------------------------------------------------------------------------
function initSettings() {
  const timerRadios    = document.querySelectorAll('input[name="timer"]');
  const textRadios     = document.querySelectorAll('input[name="textScale"]');
  const themeRadios    = document.querySelectorAll('input[name="theme"]');
  const saveBtn        = document.getElementById('saveSettingsBtn');

  // Restore saved values
  const savedTimer = LS.get('hints.timerSeconds', 60);
  const savedScale = LS.get('hints.textScale', 'normal');
  const savedTheme = LS.get('hints.theme', 'dark');

  timerRadios.forEach(r => { if (parseInt(r.value) === savedTimer) r.checked = true; });
  textRadios.forEach(r => { if (r.value === savedScale) r.checked = true; });
  themeRadios.forEach(r => { if (r.value === savedTheme) r.checked = true; });

  saveBtn.addEventListener('click', () => {
    const timer = parseInt(document.querySelector('input[name="timer"]:checked').value);
    const scale = document.querySelector('input[name="textScale"]:checked').value;
    const theme = document.querySelector('input[name="theme"]:checked').value;

    LS.set('hints.timerSeconds', timer);
    LS.set('hints.textScale', scale);
    LS.set('hints.theme', theme);

    applyTheme(theme);
    document.documentElement.setAttribute('data-text-scale', scale);

    window.location.href = '/play';
  });
}

// ---------------------------------------------------------------------------
// GTY Setup page
// ---------------------------------------------------------------------------
function initGtySetup() {
  const container = document.getElementById('teamNamesContainer');
  const radios = document.querySelectorAll('input[name="num_teams"]');

  function renderTeamInputs(count) {
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const div = document.createElement('div');
      div.className = 'gty-team-input';
      const input = document.createElement('input');
      input.type = 'text';
      input.name = `team_${i}`;
      input.placeholder = `Team ${i + 1}`;
      input.className = 'text-input';
      div.appendChild(input);
      container.appendChild(div);
    }
  }

  radios.forEach(r => {
    r.addEventListener('change', () => {
      renderTeamInputs(parseInt(r.value));
    });
  });

  // Rounds to win: custom field <-> radio interaction
  const roundsRadios = document.querySelectorAll('input[name="rounds_to_win"]');
  const roundsCustom = document.getElementById('roundsCustom');

  if (roundsCustom) {
    roundsCustom.addEventListener('input', () => {
      if (roundsCustom.value) {
        roundsRadios.forEach(r => { r.checked = false; });
      }
    });
    roundsRadios.forEach(r => {
      r.addEventListener('change', () => {
        roundsCustom.value = '';
      });
    });
  }
}

// ---------------------------------------------------------------------------
// GTY Play page
// ---------------------------------------------------------------------------
function initGtyPlay() {
  const scoreboard     = document.getElementById('scoreboard');
  const yearTimelines  = document.getElementById('yearTimelines');
  const jetonButtons   = document.getElementById('jetonButtons');
  const roundDisplay   = document.getElementById('roundDisplay');
  const songSection    = document.getElementById('songSection');
  const qrContainer    = document.getElementById('qrContainer');
  const qrPlaceholder  = document.getElementById('qrPlaceholder');
  const qrImage        = document.getElementById('qrImage');
  const songLinks      = document.getElementById('songLinks');
  const youtubeLink    = document.getElementById('youtubeLink');
  const revealSection  = document.getElementById('revealSection');
  const revealYear     = document.getElementById('revealYear');
  const revealInfo     = document.getElementById('revealInfo');
  const nextSongBtn    = document.getElementById('nextSongBtn');
  const revealBtn      = document.getElementById('revealBtn');
  const undoBtn        = document.getElementById('undoBtn');
  const awardButtons   = document.getElementById('awardButtons');
  const winnerOverlay  = document.getElementById('winnerOverlay');
  const winnerText     = document.getElementById('winnerText');
  const emptyOverlay   = document.getElementById('emptyOverlay');
  const toast          = document.getElementById('toast');

  // Cache rounds_to_win so we don't need extra state fetches
  let cachedRoundsToWin = 5;

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  function updateScoreboard(teamNames, scores, roundsToWin, jetons) {
    if (roundsToWin !== undefined) cachedRoundsToWin = roundsToWin;
    scoreboard.innerHTML = '';
    teamNames.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'gty-team-card';
      const jetonCount = (jetons && jetons[i]) || 0;
      const jetonHtml = jetonCount > 0
        ? `<div class="gty-jeton-count">${jetonCount} jeton${jetonCount !== 1 ? 's' : ''}</div>`
        : '';
      card.innerHTML = `<div class="gty-team-name">${name}</div><div class="gty-team-score">${scores[i]} / ${cachedRoundsToWin}</div>${jetonHtml}`;
      scoreboard.appendChild(card);
    });
  }

  function updateTimelines(teamNames, teamYears) {
    yearTimelines.innerHTML = '';
    if (!teamYears) return;
    teamNames.forEach((name, i) => {
      const years = teamYears[i] || [];
      if (years.length === 0) return;
      const row = document.createElement('div');
      row.className = 'gty-timeline';
      const label = document.createElement('span');
      label.className = 'gty-timeline-label';
      label.textContent = name;
      row.appendChild(label);
      const badges = document.createElement('span');
      badges.className = 'gty-timeline-badges';
      years.forEach(y => {
        const badge = document.createElement('span');
        badge.className = 'gty-year-badge';
        badge.textContent = y;
        badges.appendChild(badge);
      });
      row.appendChild(badges);
      yearTimelines.appendChild(row);
    });
  }

  function updateJetonButtons(teamNames, jetons) {
    jetonButtons.innerHTML = '';
    teamNames.forEach((name, i) => {
      const group = document.createElement('div');
      group.className = 'gty-jeton-group';

      const label = document.createElement('span');
      label.className = 'gty-jeton-label';
      label.textContent = name;
      group.appendChild(label);

      const addBtn = document.createElement('button');
      addBtn.className = 'btn gty-jeton-btn gty-jeton-btn--add';
      addBtn.textContent = '+Jeton';
      addBtn.addEventListener('click', () => changeJeton(i, 'add'));
      group.appendChild(addBtn);

      const useBtn = document.createElement('button');
      useBtn.className = 'btn gty-jeton-btn gty-jeton-btn--use';
      useBtn.textContent = '\u2212Jeton';
      useBtn.disabled = !jetons || jetons[i] <= 0;
      useBtn.addEventListener('click', () => changeJeton(i, 'use'));
      group.appendChild(useBtn);

      jetonButtons.appendChild(group);
    });
  }

  function updateAwardButtons(teamNames, enabled) {
    awardButtons.innerHTML = '';
    teamNames.forEach((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'btn gty-btn-award';
      btn.textContent = `Punt voor ${name}`;
      btn.disabled = !enabled;
      btn.addEventListener('click', () => awardPoint(i));
      awardButtons.appendChild(btn);
    });
  }

  // Shared helper to apply full state from response data
  function applyFullState(data) {
    updateScoreboard(data.team_names, data.scores, data.rounds_to_win, data.jetons);
    updateTimelines(data.team_names, data.team_years);
    updateJetonButtons(data.team_names, data.jetons);
  }

  // Fetch initial state on page load
  async function fetchState() {
    try {
      const res = await fetch('/gty/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      applyFullState(data);
      updateAwardButtons(data.team_names, data.revealed);
      if (data.round_number > 0) {
        roundDisplay.textContent = `Ronde ${data.round_number}`;
      }
      if (data.qr_url || data.youtube_link) {
        songSection.hidden = false;
        if (data.qr_url) {
          qrImage.src = data.qr_url;
          qrImage.hidden = false;
          qrPlaceholder.hidden = true;
        }
        if (data.youtube_link) {
          youtubeLink.href = data.youtube_link;
          songLinks.hidden = false;
        }
      }
      if (data.revealed && data.artist) {
        revealSection.hidden = false;
        revealYear.textContent = data.year;
        revealInfo.textContent = `${data.artist} – ${data.title}`;
        revealBtn.disabled = true;
      }
      if (data.winner) {
        winnerText.textContent = `${data.winner} wint!`;
        winnerOverlay.hidden = false;
      }
      undoBtn.disabled = !data.revealed;
    } catch {}
  }

  async function fetchNextSong() {
    try {
      const res = await fetch('/gty/next', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 204) {
        emptyOverlay.hidden = false;
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij ophalen nummer');
        return;
      }
      const data = await res.json();

      // Show song section
      songSection.hidden = false;
      revealSection.hidden = true;
      revealBtn.disabled = false;
      undoBtn.disabled = true;

      // Update round
      roundDisplay.textContent = `Ronde ${data.round}`;

      // QR code
      if (data.qr_url) {
        qrImage.src = data.qr_url;
        qrImage.hidden = false;
        qrPlaceholder.hidden = true;
      } else {
        qrImage.hidden = true;
        qrPlaceholder.hidden = false;
        qrPlaceholder.textContent = 'Geen QR code beschikbaar';
      }

      // YouTube link
      if (data.youtube_link) {
        youtubeLink.href = data.youtube_link;
        songLinks.hidden = false;
      } else {
        songLinks.hidden = true;
      }

      // Disable award buttons until reveal
      const state = await fetch('/gty/state', { credentials: 'same-origin' }).then(r => r.json());
      updateAwardButtons(state.team_names, false);
    } catch (err) {
      showToast('Netwerkfout');
    }
  }

  async function revealAnswer() {
    try {
      const res = await fetch('/gty/reveal', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij onthullen');
        return;
      }
      const data = await res.json();
      revealYear.textContent = data.year;
      revealInfo.textContent = `${data.artist} – ${data.title}`;
      revealSection.hidden = false;
      revealSection.classList.remove('fade-in');
      void revealSection.offsetWidth;
      revealSection.classList.add('fade-in');
      revealBtn.disabled = true;
      undoBtn.disabled = false;

      // Enable award buttons
      const state = await fetch('/gty/state', { credentials: 'same-origin' }).then(r => r.json());
      updateAwardButtons(state.team_names, true);
    } catch (err) {
      showToast('Netwerkfout');
    }
  }

  async function awardPoint(teamIdx) {
    try {
      const res = await fetch('/gty/award', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `team=${teamIdx}`,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij toekennen punt');
        return;
      }
      const data = await res.json();
      updateScoreboard(data.team_names, data.scores, undefined, data.jetons);
      updateTimelines(data.team_names, data.team_years);
      updateJetonButtons(data.team_names, data.jetons);

      if (data.winner) {
        winnerText.textContent = `${data.winner} wint!`;
        winnerOverlay.hidden = false;
      }
    } catch (err) {
      showToast('Netwerkfout');
    }
  }

  async function undoAward() {
    try {
      const res = await fetch('/gty/undo', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij ongedaan maken');
        return;
      }
      const data = await res.json();
      updateScoreboard(data.team_names, data.scores, undefined, data.jetons);
      updateTimelines(data.team_names, data.team_years);
      updateJetonButtons(data.team_names, data.jetons);
      winnerOverlay.hidden = true;
      showToast('Punt ongedaan gemaakt');
    } catch (err) {
      showToast('Netwerkfout');
    }
  }

  async function changeJeton(teamIdx, action) {
    try {
      const res = await fetch('/gty/jeton', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `team=${teamIdx}&action=${action}`,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij jeton');
        return;
      }
      const data = await res.json();
      // Re-fetch full state to update scoreboard jeton counts
      const state = await fetch('/gty/state', { credentials: 'same-origin' }).then(r => r.json());
      updateScoreboard(state.team_names, state.scores, state.rounds_to_win, data.jetons);
      updateJetonButtons(data.team_names, data.jetons);
    } catch (err) {
      showToast('Netwerkfout');
    }
  }

  // Event listeners
  nextSongBtn.addEventListener('click', fetchNextSong);
  revealBtn.addEventListener('click', revealAnswer);
  undoBtn.addEventListener('click', undoAward);

  // Initial load
  fetchState();
}

// ---------------------------------------------------------------------------
// 30 Seconds Setup page
// ---------------------------------------------------------------------------
function initTsSetup() {
  const container = document.getElementById('teamNamesContainer');
  const radios = document.querySelectorAll('input[name="num_teams"]');

  function renderTeamInputs(count) {
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const div = document.createElement('div');
      div.className = 'gty-team-input';
      const input = document.createElement('input');
      input.type = 'text';
      input.name = `team_${i}`;
      input.placeholder = `Team ${i + 1}`;
      input.className = 'text-input';
      div.appendChild(input);
      container.appendChild(div);
    }
  }

  radios.forEach(r => {
    r.addEventListener('change', () => {
      renderTeamInputs(parseInt(r.value));
    });
  });
}

// ---------------------------------------------------------------------------
// 30 Seconds Play page
// ---------------------------------------------------------------------------
function initTsPlay() {
  const TEAM_COLORS = ['#4F46E5', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

  const scoreboard     = document.getElementById('scoreboard');
  const boardBars      = document.getElementById('boardBars');
  const finishLabel    = document.getElementById('finishLabel');
  const currentTeamEl  = document.getElementById('currentTeam');
  const phaseRoll      = document.getElementById('phaseRoll');
  const rollBtn        = document.getElementById('rollBtn');
  const diceResult     = document.getElementById('diceResult');
  const diceValue      = document.getElementById('diceValue');
  const phaseDraw      = document.getElementById('phaseDraw');
  const drawBtn        = document.getElementById('drawBtn');
  const phasePlay      = document.getElementById('phasePlay');
  const timerBar       = document.getElementById('timerBar');
  const timerDisplay   = document.getElementById('timerDisplay');
  const wordsContainer = document.getElementById('wordsContainer');

  const phaseScore     = document.getElementById('phaseScore');
  const wordsCheck     = document.getElementById('wordsCheck');
  const scoreSummary   = document.getElementById('scoreSummary');
  const submitScoreBtn = document.getElementById('submitScoreBtn');
  const undoBtn        = document.getElementById('undoBtn');
  const winnerOverlay  = document.getElementById('winnerOverlay');
  const winnerText     = document.getElementById('winnerText');
  const toast          = document.getElementById('toast');

  let gameState = null;
  let currentWords = [];
  let currentHandicap = 0;
  let timer = null;
  let timerRunning = false;

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  function updateScoreboard(teamNames, positions, finishScore, activeIdx) {
    scoreboard.innerHTML = '';
    teamNames.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'ts-team-card' + (i === activeIdx ? ' ts-active' : '');
      card.style.borderColor = (i === activeIdx) ? TEAM_COLORS[i] : '';
      if (i === activeIdx) card.style.boxShadow = `0 0 0 2px ${TEAM_COLORS[i]}`;
      card.innerHTML = `
        <div class="ts-team-name" style="color:${TEAM_COLORS[i]}">${name}</div>
        <div class="ts-team-position">${positions[i]} / ${finishScore}</div>
      `;
      scoreboard.appendChild(card);
    });
  }

  function updateBoard(teamNames, positions, finishScore) {
    boardBars.innerHTML = '';
    finishLabel.textContent = `FINISH (${finishScore})`;
    teamNames.forEach((name, i) => {
      const pct = Math.min(100, (positions[i] / finishScore) * 100);
      const bar = document.createElement('div');
      bar.className = 'ts-board-bar';
      bar.style.width = pct + '%';
      bar.style.backgroundColor = TEAM_COLORS[i];
      bar.style.height = `${Math.floor(20 / teamNames.length)}px`;
      bar.style.top = `${i * Math.floor(20 / teamNames.length)}px`;
      bar.title = `${name}: ${positions[i]}`;
      boardBars.appendChild(bar);
    });
  }

  function updateCurrentTeam(teamNames, idx) {
    currentTeamEl.textContent = `Aan de beurt: ${teamNames[idx]}`;
    currentTeamEl.style.color = TEAM_COLORS[idx];
    currentTeamEl.style.background = `color-mix(in srgb, ${TEAM_COLORS[idx]} 8%, var(--bg-card))`;
  }

  function showPhase(phase) {
    phaseRoll.hidden = phase !== 'roll';
    phaseDraw.hidden = phase !== 'draw';
    phasePlay.hidden = phase !== 'play';
    phaseScore.hidden = phase !== 'score';
  }

  // -- Timer --
  function createTimer(durationSec) {
    return new Timer(durationSec, (remaining, total) => {
      const secs = Math.ceil(remaining);
      timerDisplay.textContent = secs;
      const pct = remaining / total;
      timerBar.style.width = (pct * 100) + '%';
      timerBar.classList.toggle('warning', pct <= 0.3 && pct > 0.1);
      timerBar.classList.toggle('danger', pct <= 0.1);
    }, () => {
      // Time's up
      timerRunning = false;
      playTimeUpSound();
      try { navigator.vibrate([300, 100, 300, 100, 500]); } catch {}
      goToScorePhase();
    });
  }

  function goToScorePhase() {
    showPhase('score');
    // Build check list from current words
    wordsCheck.innerHTML = '';
    currentWords.forEach((word, i) => {
      const item = document.createElement('div');
      item.className = 'ts-word-check-item';
      item.dataset.index = i;
      item.innerHTML = `
        <div class="ts-check-icon">✓</div>
        <div class="ts-word-text">${word}</div>
      `;
      item.addEventListener('click', () => {
        item.classList.toggle('ts-checked');
        updateScoreSummary();
      });
      wordsCheck.appendChild(item);
    });
    updateScoreSummary();
  }

  function getCheckedCount() {
    return wordsCheck.querySelectorAll('.ts-checked').length;
  }

  function updateScoreSummary() {
    const correct = getCheckedCount();
    const steps = Math.max(0, correct - currentHandicap);
    scoreSummary.innerHTML = `
      <div class="ts-score-calc">${correct} juist − ${currentHandicap} handicap</div>
      <div class="ts-score-steps">= ${steps} vakje${steps !== 1 ? 's' : ''} vooruit</div>
    `;
  }

  // -- API calls --
  async function fetchState() {
    try {
      const res = await fetch('/ts/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      gameState = await res.json();

      updateScoreboard(gameState.team_names, gameState.positions, gameState.finish_score, gameState.current_team_idx);
      updateBoard(gameState.team_names, gameState.positions, gameState.finish_score);
      updateCurrentTeam(gameState.team_names, gameState.current_team_idx);

      if (gameState.winner) {
        winnerText.textContent = `${gameState.winner} wint! 🎉`;
        winnerOverlay.hidden = false;
      }

      // Determine current phase
      if (gameState.handicap !== null && gameState.current_words && gameState.current_words.length > 0) {
        // We have words drawn, show play phase
        currentWords = gameState.current_words;
        currentHandicap = gameState.handicap;
        showWordsOnCard(currentWords);
        showPhase('play');
        diceResult.hidden = false;
        diceValue.textContent = currentHandicap;
      } else if (gameState.handicap !== null) {
        currentHandicap = gameState.handicap;
        diceResult.hidden = false;
        diceValue.textContent = currentHandicap;
        showPhase('draw');
      } else {
        showPhase('roll');
        diceResult.hidden = true;
      }

      undoBtn.disabled = !gameState.round_number;
    } catch {}
  }

  async function rollDice() {
    try {
      rollBtn.disabled = true;
      // Animate
      diceResult.hidden = false;
      diceResult.classList.add('ts-dice-rolling');
      diceValue.textContent = '?';

      const res = await fetch('/ts/roll', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij dobbelen');
        rollBtn.disabled = false;
        return;
      }
      const data = await res.json();
      currentHandicap = data.handicap;

      // Short delay for animation
      await new Promise(r => setTimeout(r, 500));
      diceResult.classList.remove('ts-dice-rolling');
      diceValue.textContent = data.handicap;

      showPhase('draw');
      rollBtn.disabled = false;
    } catch (err) {
      showToast('Netwerkfout');
      rollBtn.disabled = false;
    }
  }

  function showWordsOnCard(words) {
    wordsContainer.innerHTML = '';
    words.forEach((word, i) => {
      const card = document.createElement('div');
      card.className = 'ts-word-card';
      card.innerHTML = `
        <div class="ts-word-number">${i + 1}</div>
        <div class="ts-word-text">${word}</div>
      `;
      wordsContainer.appendChild(card);
    });
  }

  async function drawCard() {
    try {
      drawBtn.disabled = true;
      const res = await fetch('/ts/draw', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij trekken kaart');
        drawBtn.disabled = false;
        return;
      }
      const data = await res.json();
      currentWords = data.words;

      showWordsOnCard(currentWords);
      showPhase('play');

      // Start timer immediately
      timer = createTimer(30);
      timerDisplay.textContent = '30';
      timerBar.style.width = '100%';
      timerBar.classList.remove('warning', 'danger');
      timer.start();
      timerRunning = true;

      drawBtn.disabled = false;
    } catch (err) {
      showToast('Netwerkfout');
      drawBtn.disabled = false;
    }
  }

  async function submitScore() {
    const correct = getCheckedCount();
    try {
      submitScoreBtn.disabled = true;
      const res = await fetch('/ts/score', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `correct=${correct}`,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij opslaan score');
        submitScoreBtn.disabled = false;
        return;
      }
      const data = await res.json();

      // Show result toast
      showToast(`${data.steps} vakje${data.steps !== 1 ? 's' : ''} vooruit!`);

      // Update UI
      updateScoreboard(data.team_names, data.positions, data.finish_score, data.current_team_idx);
      updateBoard(data.team_names, data.positions, data.finish_score);
      updateCurrentTeam(data.team_names, data.current_team_idx);

      if (data.winner) {
        winnerText.textContent = `${data.winner} wint! 🎉`;
        winnerOverlay.hidden = false;
      }

      // Reset for next turn
      showPhase('roll');
      diceResult.hidden = true;
      currentWords = [];
      currentHandicap = 0;
      undoBtn.disabled = false;
      submitScoreBtn.disabled = false;
    } catch (err) {
      showToast('Netwerkfout');
      submitScoreBtn.disabled = false;
    }
  }

  async function undoLast() {
    try {
      const res = await fetch('/ts/undo', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout bij ongedaan maken');
        return;
      }
      const data = await res.json();

      updateScoreboard(data.team_names, data.positions, data.finish_score, data.current_team_idx);
      updateBoard(data.team_names, data.positions, data.finish_score);
      updateCurrentTeam(data.team_names, data.current_team_idx);
      winnerOverlay.hidden = true;
      showToast('Laatste beurt ongedaan gemaakt');

      // Reset to roll phase for the restored team
      showPhase('roll');
      diceResult.hidden = true;
    } catch (err) {
      showToast('Netwerkfout');
    }
  }

  // -- Event listeners --
  rollBtn.addEventListener('click', rollDice);
  drawBtn.addEventListener('click', drawCard);
  submitScoreBtn.addEventListener('click', submitScore);
  undoBtn.addEventListener('click', undoLast);

  // Initial load
  fetchState();
}

// ---------------------------------------------------------------------------
// Generic Setup page (team name inputs, used by Taboe, Bluf, etc.)
// ---------------------------------------------------------------------------
function initGenericSetup() {
  const container = document.getElementById('teamNamesContainer');
  const radios = document.querySelectorAll('input[name="num_teams"]');
  if (!container || !radios.length) return;

  function renderTeamInputs(count) {
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const div = document.createElement('div');
      div.className = 'gty-team-input';
      const input = document.createElement('input');
      input.type = 'text';
      input.name = `team_${i}`;
      input.placeholder = `Team ${i + 1}`;
      input.className = 'text-input';
      div.appendChild(input);
      container.appendChild(div);
    }
  }

  radios.forEach(r => {
    r.addEventListener('change', () => {
      renderTeamInputs(parseInt(r.value));
    });
  });
}

// ---------------------------------------------------------------------------
// Taboe Play page
// ---------------------------------------------------------------------------
function initTaboePlay() {
  const TEAM_COLORS = ['#4F46E5', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

  const scoreboard    = document.getElementById('scoreboard');
  const boardBars     = document.getElementById('boardBars');
  const finishLabel   = document.getElementById('finishLabel');
  const currentTeamEl = document.getElementById('currentTeam');
  const phaseStart    = document.getElementById('phaseStart');
  const phasePlay     = document.getElementById('phasePlay');
  const phaseEnd      = document.getElementById('phaseEnd');
  const startTurnBtn  = document.getElementById('startTurnBtn');
  const timerBar      = document.getElementById('timerBar');
  const timerDisplay  = document.getElementById('timerDisplay');
  const taboeWord     = document.getElementById('taboeWord');
  const taboeForbidden = document.getElementById('taboeForbidden');
  const turnScore     = document.getElementById('turnScore');
  const correctBtn    = document.getElementById('correctBtn');
  const skipBtn       = document.getElementById('skipBtn');
  const taboeBtn      = document.getElementById('taboeBtn');
  const endSummary    = document.getElementById('endSummary');
  const confirmEndBtn = document.getElementById('confirmEndBtn');
  const undoBtn       = document.getElementById('undoBtn');
  const winnerOverlay = document.getElementById('winnerOverlay');
  const winnerText    = document.getElementById('winnerText');
  const toast         = document.getElementById('toast');

  let gameState = null;
  let timer = null;
  let turnCorrect = 0;
  let turnTaboe = 0;

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  function updateScoreboard(st) {
    scoreboard.innerHTML = '';
    st.team_names.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'ts-team-card' + (i === st.current_team_idx ? ' ts-active' : '');
      card.style.borderColor = (i === st.current_team_idx) ? TEAM_COLORS[i] : '';
      if (i === st.current_team_idx) card.style.boxShadow = `0 0 0 2px ${TEAM_COLORS[i]}`;
      card.innerHTML = `
        <div class="ts-team-name" style="color:${TEAM_COLORS[i]}">${name}</div>
        <div class="ts-team-position">${st.scores[i]} / ${st.finish_score}</div>
      `;
      scoreboard.appendChild(card);
    });
    finishLabel.textContent = `FINISH (${st.finish_score})`;
    boardBars.innerHTML = '';
    st.team_names.forEach((name, i) => {
      const pct = Math.min(100, (st.scores[i] / st.finish_score) * 100);
      const bar = document.createElement('div');
      bar.className = 'ts-board-bar';
      bar.style.width = pct + '%';
      bar.style.backgroundColor = TEAM_COLORS[i];
      bar.style.height = `${Math.floor(20 / st.team_names.length)}px`;
      bar.style.top = `${i * Math.floor(20 / st.team_names.length)}px`;
      bar.title = `${name}: ${st.scores[i]}`;
      boardBars.appendChild(bar);
    });
    currentTeamEl.textContent = `Aan de beurt: ${st.team_names[st.current_team_idx]}`;
    currentTeamEl.style.color = TEAM_COLORS[st.current_team_idx];
    currentTeamEl.style.background = `color-mix(in srgb, ${TEAM_COLORS[st.current_team_idx]} 8%, var(--bg-card))`;
  }

  function showPhase(phase) {
    phaseStart.hidden = phase !== 'start';
    phasePlay.hidden = phase !== 'play';
    phaseEnd.hidden = phase !== 'end';
  }

  function showCard(card) {
    taboeWord.textContent = card.word;
    taboeForbidden.innerHTML = card.taboo.map(w =>
      `<span class="taboe-forbidden-word">🚫 ${w}</span>`
    ).join('');
  }

  function updateTurnScore() {
    turnScore.innerHTML = `✓ ${turnCorrect} &nbsp; ⚠ ${turnTaboe}`;
  }

  // Timer
  function createTimer() {
    return new Timer(60, (remaining, total) => {
      const secs = Math.ceil(remaining);
      timerDisplay.textContent = secs;
      const pct = remaining / total;
      timerBar.style.width = (pct * 100) + '%';
      timerBar.classList.toggle('warning', pct <= 0.3 && pct > 0.1);
      timerBar.classList.toggle('danger', pct <= 0.1);
    }, () => {
      playTimeUpSound();
      try { navigator.vibrate([300, 100, 300, 100, 500]); } catch {}
      endTurn();
    });
  }

  async function drawCard() {
    try {
      const res = await fetch('/taboe/draw', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 204) {
        showToast('Geen kaarten meer!');
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async function startTurn() {
    turnCorrect = 0;
    turnTaboe = 0;
    updateTurnScore();
    const card = await drawCard();
    if (!card) return;
    showCard(card);
    showPhase('play');
    timer = createTimer();
    timerDisplay.textContent = '60';
    timerBar.style.width = '100%';
    timerBar.classList.remove('warning', 'danger');
    timer.start();
  }

  async function markCorrect() {
    const res = await fetch('/taboe/correct', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) return;
    turnCorrect++;
    updateTurnScore();
    const card = await drawCard();
    if (!card) { endTurn(); return; }
    showCard(card);
  }

  async function markTaboe() {
    const res = await fetch('/taboe/taboe_fout', { method: 'POST', credentials: 'same-origin' });
    if (!res.ok) return;
    turnTaboe++;
    updateTurnScore();
    const card = await drawCard();
    if (!card) { endTurn(); return; }
    showCard(card);
  }

  async function skipCard() {
    const card = await drawCard();
    if (!card) { endTurn(); return; }
    showCard(card);
  }

  async function endTurn() {
    if (timer) timer.pause();
    showPhase('end');
    const netScore = Math.max(0, turnCorrect - turnTaboe);
    endSummary.innerHTML = `
      <div class="ts-score-summary">
        <div class="ts-score-calc">✓ ${turnCorrect} correct − ⚠ ${turnTaboe} taboe</div>
        <div class="ts-score-steps">= ${netScore} punt${netScore !== 1 ? 'en' : ''}</div>
      </div>
    `;
  }

  async function confirmEnd() {
    try {
      const res = await fetch('/taboe/end_turn', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      gameState = data;
      updateScoreboard(data);
      if (data.winner) {
        winnerText.textContent = `${data.winner} wint! 🏆`;
        winnerOverlay.hidden = false;
      }
      showPhase('start');
      undoBtn.disabled = false;
    } catch { showToast('Netwerkfout'); }
  }

  async function undoLast() {
    try {
      const res = await fetch('/taboe/undo', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { showToast('Kan niet ongedaan maken'); return; }
      const data = await res.json();
      gameState = data;
      updateScoreboard(data);
      winnerOverlay.hidden = true;
      showPhase('start');
      showToast('Laatste beurt ongedaan gemaakt');
    } catch { showToast('Netwerkfout'); }
  }

  async function fetchState() {
    try {
      const res = await fetch('/taboe/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      gameState = await res.json();
      updateScoreboard(gameState);
      if (gameState.winner) {
        winnerText.textContent = `${gameState.winner} wint! 🏆`;
        winnerOverlay.hidden = false;
      }
      showPhase('start');
      undoBtn.disabled = !gameState.round_number;
    } catch {}
  }

  startTurnBtn.addEventListener('click', startTurn);
  correctBtn.addEventListener('click', markCorrect);
  taboeBtn.addEventListener('click', markTaboe);
  skipBtn.addEventListener('click', skipCard);
  confirmEndBtn.addEventListener('click', confirmEnd);
  undoBtn.addEventListener('click', undoLast);

  fetchState();
}

// ---------------------------------------------------------------------------
// Wie Ben Ik Play page
// ---------------------------------------------------------------------------
function initWbiPlay() {
  const personEl    = document.getElementById('wbiPerson');
  const counterEl   = document.getElementById('wbiCounter');
  const nextBtn     = document.getElementById('wbiNextBtn');
  const emptyOverlay = document.getElementById('emptyOverlay');
  const toast       = document.getElementById('toast');

  let shown = 0;

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  async function fetchNext() {
    try {
      nextBtn.disabled = true;
      const res = await fetch('/wbi/next', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 204) {
        emptyOverlay.hidden = false;
        nextBtn.disabled = false;
        return;
      }
      if (!res.ok) { showToast('Fout bij laden'); nextBtn.disabled = false; return; }
      const data = await res.json();
      shown++;
      personEl.textContent = data.person;
      personEl.style.animation = 'none';
      personEl.offsetHeight; // reflow
      personEl.style.animation = '';
      counterEl.textContent = `Persoon ${shown}`;
      nextBtn.disabled = false;
    } catch { showToast('Netwerkfout'); nextBtn.disabled = false; }
  }

  nextBtn.addEventListener('click', fetchNext);
}

// ---------------------------------------------------------------------------
// Muziekbingo Setup page
// ---------------------------------------------------------------------------
function initMbingoSetup() {
  const container = document.getElementById('teamNamesContainer');
  const radios = document.querySelectorAll('input[name="num_players"]');
  if (!container || !radios.length) return;

  function renderPlayerInputs(count) {
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const div = document.createElement('div');
      div.className = 'gty-team-input';
      const input = document.createElement('input');
      input.type = 'text';
      input.name = `player_${i}`;
      input.placeholder = `Speler ${i + 1}`;
      input.className = 'text-input';
      div.appendChild(input);
      container.appendChild(div);
    }
  }

  radios.forEach(r => {
    r.addEventListener('change', () => renderPlayerInputs(parseInt(r.value)));
  });
}

// ---------------------------------------------------------------------------
// Muziekbingo Play page (single shared card with QR)
// ---------------------------------------------------------------------------
function initMbingoPlay() {
  const PLAYER_COLORS = ['#4F46E5', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

  const playerScores    = document.getElementById('playerScores');
  const qrPlaceholder   = document.getElementById('qrPlaceholder');
  const qrImage         = document.getElementById('qrImage');
  const songLinks       = document.getElementById('songLinks');
  const statusLabel     = document.getElementById('statusLabel');
  const revealedSong    = document.getElementById('revealedSong');
  const revealArtist    = document.getElementById('revealArtist');
  const revealTitle     = document.getElementById('revealTitle');
  const songProgress    = document.getElementById('songProgress');
  const nowPlaying      = document.getElementById('nowPlaying');
  const bingoGrid       = document.getElementById('bingoGrid');
  const nextSongBtn     = document.getElementById('nextSongBtn');
  const revealBtn       = document.getElementById('revealBtn');
  const claimPopup      = document.getElementById('claimPopup');
  const popupButtons    = document.getElementById('popupButtons');
  const popupClose      = document.getElementById('popupClose');
  const finishOverlay   = document.getElementById('finishOverlay');
  const finalScores     = document.getElementById('finalScores');
  const toast           = document.getElementById('toast');

  let state = null;
  let pendingCellIdx = null;   // which cell did the user tap?
  let claiming = false;        // prevent double-claims

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  // -- Scores --
  function calcScores(st) {
    const s = new Array(st.num_players).fill(0);
    st.card.forEach(c => { if (c.claimed_by != null) s[c.claimed_by]++; });
    return s;
  }

  function renderScoreboard(st) {
    playerScores.innerHTML = '';
    const scores = calcScores(st);
    st.player_names.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'mbingo-player-card';
      card.style.borderColor = PLAYER_COLORS[i];
      card.innerHTML = `
        <div class="mbingo-player-name" style="color:${PLAYER_COLORS[i]}">${name}</div>
        <div class="mbingo-player-score">${scores[i]}</div>
      `;
      playerScores.appendChild(card);
    });
  }

  // -- Grid --
  function renderGrid(st) {
    bingoGrid.innerHTML = '';
    bingoGrid.dataset.size = st.card_size;
    st.card.forEach((cell, idx) => {
      const el = document.createElement('div');
      el.className = 'mbingo-cell';
      el.dataset.idx = idx;
      el.innerHTML = `<span class="mbingo-cell-artist">${cell.artist}</span><span class="mbingo-cell-title">${cell.title}</span>`;
      if (cell.claimed_by != null) {
        el.classList.add('mbingo-cell--claimed');
        el.style.background = PLAYER_COLORS[cell.claimed_by];
        el.style.borderColor = PLAYER_COLORS[cell.claimed_by];
      }
      el.addEventListener('click', () => onCellTap(idx, el));
      bingoGrid.appendChild(el);
    });
  }

  // -- Cell tap → show player popup --
  function onCellTap(idx, cellEl) {
    if (!state || state.revealed) return;
    if (state.play_idx < 0) { showToast('Start eerst een nummer!'); return; }
    if (state.card[idx].claimed_by != null) { showToast('Al geclaimd!'); return; }

    pendingCellIdx = idx;
    showPopup(cellEl);
  }

  function showPopup(anchorEl) {
    popupButtons.innerHTML = '';
    state.player_names.forEach((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'mbingo-popup-btn';
      btn.style.background = PLAYER_COLORS[i];
      btn.style.color = '#fff';
      btn.textContent = name;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        doClaim(i);
      });
      popupButtons.appendChild(btn);
    });

    // Position popup near the tapped cell
    const gridRect = bingoGrid.getBoundingClientRect();
    const cellRect = anchorEl.getBoundingClientRect();
    const popupEl = claimPopup;
    popupEl.hidden = false;

    requestAnimationFrame(() => {
      const pw = popupEl.offsetWidth;
      const ph = popupEl.offsetHeight;
      // center horizontally relative to cell, clamp to screen
      let left = cellRect.left + cellRect.width / 2 - pw / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
      // prefer above the cell, fall below if no room
      let top = cellRect.top - ph - 8;
      if (top < 8) top = cellRect.bottom + 8;
      popupEl.style.left = left + 'px';
      popupEl.style.top = top + 'px';
    });
  }

  function hidePopup() {
    claimPopup.hidden = true;
    pendingCellIdx = null;
  }

  popupClose.addEventListener('click', (e) => { e.stopPropagation(); hidePopup(); });
  document.addEventListener('click', (e) => {
    if (!claimPopup.hidden && !claimPopup.contains(e.target) && !bingoGrid.contains(e.target)) {
      hidePopup();
    }
  });

  // -- Claim logic --
  async function doClaim(playerIdx) {
    if (claiming || pendingCellIdx === null) return;
    claiming = true;
    const cellIdx = pendingCellIdx;
    hidePopup();

    try {
      const res = await fetch('/mbingo/claim', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `player=${playerIdx}&cell=${cellIdx}`,
      });
      if (!res.ok) { const d = await res.json(); showToast(d.error || 'Fout'); claiming = false; return; }
      const data = await res.json();

      if (!data.correct) {
        // Wrong cell – shake it
        const cellEl = bingoGrid.children[cellIdx];
        if (cellEl) {
          cellEl.classList.add('mbingo-cell--wrong');
          setTimeout(() => cellEl.classList.remove('mbingo-cell--wrong'), 600);
        }
        showToast(data.message || 'Fout vakje!');
        claiming = false;
        return;
      }

      // Correct!
      state.card[cellIdx].claimed_by = data.player_idx;
      state.revealed = true;
      renderGrid(state);
      renderScoreboard(state);

      // Highlight claimed cell
      const cellEl = bingoGrid.children[cellIdx];
      if (cellEl) cellEl.classList.add('mbingo-cell--highlight');

      // Show revealed song
      showRevealed(data.artist, data.title);
      setPhase('revealed');
      claiming = false;
    } catch { showToast('Netwerkfout'); claiming = false; }
  }

  // -- Song links --
  function showSongLinks(data) {
    songLinks.innerHTML = '';
    if (data.youtube_link) {
      const a = document.createElement('a');
      a.href = data.youtube_link; a.target = '_blank'; a.textContent = '▶ YouTube';
      songLinks.appendChild(a);
    }
    if (data.spotify_link) {
      const a = document.createElement('a');
      a.href = data.spotify_link; a.target = '_blank'; a.textContent = '🎵 Spotify';
      songLinks.appendChild(a);
    }
    songLinks.hidden = !songLinks.children.length;
  }

  // -- Phases --
  function setPhase(phase) {
    // phase: 'idle' | 'listening' | 'revealed'
    nowPlaying.classList.remove('mbingo-listening', 'mbingo-revealed-state');
    if (phase === 'idle') {
      statusLabel.textContent = 'Druk op ▶ om te starten';
      statusLabel.hidden = false;
      revealedSong.hidden = true;
      nextSongBtn.hidden = false;
      revealBtn.hidden = true;
    } else if (phase === 'listening') {
      statusLabel.textContent = '🎧 Luister… wie herkent het?';
      statusLabel.hidden = false;
      revealedSong.hidden = true;
      nowPlaying.classList.add('mbingo-listening');
      nextSongBtn.hidden = true;
      revealBtn.hidden = false;
    } else if (phase === 'revealed') {
      statusLabel.hidden = true;
      revealedSong.hidden = false;
      nowPlaying.classList.add('mbingo-revealed-state');
      nextSongBtn.hidden = false;
      revealBtn.hidden = true;
    }
  }

  function showRevealed(artist, title) {
    revealArtist.textContent = artist;
    revealTitle.textContent = title;
  }

  // -- Next song --
  async function nextSong() {
    try {
      nextSongBtn.disabled = true;
      const res = await fetch('/mbingo/next_song', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 204) { showFinish(); return; }
      if (!res.ok) { showToast('Fout'); nextSongBtn.disabled = false; return; }
      const data = await res.json();

      state.play_idx = data.song_number - 1;
      state.revealed = false;
      songProgress.textContent = `${data.song_number} / ${data.total_songs}`;

      if (data.qr_url) {
        qrImage.src = data.qr_url; qrImage.hidden = false; qrPlaceholder.hidden = true;
      } else {
        qrImage.hidden = true; qrPlaceholder.hidden = false; qrPlaceholder.textContent = '♫';
      }
      showSongLinks(data);
      setPhase('listening');
      // Remove highlight from previous round
      bingoGrid.querySelectorAll('.mbingo-cell--highlight').forEach(c => c.classList.remove('mbingo-cell--highlight'));
      nextSongBtn.disabled = false;
    } catch { showToast('Netwerkfout'); nextSongBtn.disabled = false; }
  }

  // -- Reveal (skip) --
  async function revealSong() {
    try {
      revealBtn.disabled = true;
      const res = await fetch('/mbingo/reveal', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { showToast('Fout'); revealBtn.disabled = false; return; }
      const data = await res.json();
      state.revealed = true;
      showRevealed(data.artist, data.title);
      setPhase('revealed');

      // Highlight the unclaimed cell
      const cellEl = bingoGrid.children[data.card_idx];
      if (cellEl) cellEl.classList.add('mbingo-cell--highlight');
      revealBtn.disabled = false;
    } catch { showToast('Netwerkfout'); revealBtn.disabled = false; }
  }

  // -- Finish --
  function showFinish() {
    const scores = calcScores(state);
    finalScores.innerHTML = '';
    const sorted = state.player_names
      .map((n, i) => ({ name: n, score: scores[i], color: PLAYER_COLORS[i] }))
      .sort((a, b) => b.score - a.score);
    sorted.forEach((p, rank) => {
      const div = document.createElement('div');
      div.style.cssText = `padding:.5rem;font-weight:700;font-size:1.1rem;color:${p.color}`;
      div.textContent = `${rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : ''} ${p.name}: ${p.score} vakjes`;
      finalScores.appendChild(div);
    });
    finishOverlay.hidden = false;
  }

  // -- Initial state --
  async function fetchState() {
    try {
      const res = await fetch('/mbingo/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      state = await res.json();
      renderScoreboard(state);
      renderGrid(state);
      songProgress.textContent = state.play_idx >= 0
        ? `${state.play_idx + 1} / ${state.total_songs}` : '';

      if (state.revealed && state.current_artist) {
        showRevealed(state.current_artist, state.current_title);
        if (state.qr_url) { qrImage.src = state.qr_url; qrImage.hidden = false; qrPlaceholder.hidden = true; }
        showSongLinks(state);
        setPhase('revealed');
      } else if (state.play_idx >= 0 && !state.revealed) {
        if (state.qr_url) { qrImage.src = state.qr_url; qrImage.hidden = false; qrPlaceholder.hidden = true; }
        showSongLinks(state);
        setPhase('listening');
      } else {
        setPhase('idle');
      }
    } catch {}
  }

  nextSongBtn.addEventListener('click', nextSong);
  revealBtn.addEventListener('click', revealSong);
  fetchState();
}

// ---------------------------------------------------------------------------
// Schattingen Play page
// ---------------------------------------------------------------------------
function initSchatPlay() {
  const TEAM_COLORS = ['#4F46E5', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

  const scoreboard        = document.getElementById('scoreboard');
  const roundInfo         = document.getElementById('roundInfo');
  const phaseNext         = document.getElementById('phaseNext');
  const phaseGuess        = document.getElementById('phaseGuess');
  const phaseReveal       = document.getElementById('phaseReveal');
  const nextQuestionBtn   = document.getElementById('nextQuestionBtn');
  const questionText      = document.getElementById('questionText');
  const guessSection      = document.getElementById('guessSection');
  const revealBtn         = document.getElementById('revealBtn');
  const revealQuestionText = document.getElementById('revealQuestionText');
  const answerValue       = document.getElementById('answerValue');
  const guessResults      = document.getElementById('guessResults');
  const nextAfterRevealBtn = document.getElementById('nextAfterRevealBtn');
  const winnerOverlay     = document.getElementById('winnerOverlay');
  const winnerText        = document.getElementById('winnerText');
  const toast             = document.getElementById('toast');

  let gameState = null;
  let submittedGuesses = {};

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  function showPhase(phase) {
    phaseNext.hidden = phase !== 'next';
    phaseGuess.hidden = phase !== 'guess';
    phaseReveal.hidden = phase !== 'reveal';
  }

  function updateScoreboard(st) {
    scoreboard.innerHTML = '';
    st.team_names.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'ts-team-card';
      card.innerHTML = `
        <div class="ts-team-name" style="color:${TEAM_COLORS[i]}">${name}</div>
        <div class="ts-team-position">${st.scores[i]} / ${st.points_to_win}</div>
      `;
      scoreboard.appendChild(card);
    });
  }

  function renderGuessInputs(st) {
    guessSection.innerHTML = '';
    submittedGuesses = {};
    st.team_names.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'schat-team-guess';
      row.innerHTML = `
        <span class="schat-team-label" style="color:${TEAM_COLORS[i]}">${name}</span>
        <input type="number" class="schat-guess-input" id="guessInput${i}" placeholder="Schatting..." step="any">
        <button class="schat-submit-btn" id="guessBtn${i}" data-team="${i}">✓</button>
      `;
      guessSection.appendChild(row);

      const btn = row.querySelector(`#guessBtn${i}`);
      const input = row.querySelector(`#guessInput${i}`);
      btn.addEventListener('click', () => submitGuess(i, input, btn));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitGuess(i, input, btn);
      });
    });
  }

  async function submitGuess(teamIdx, input, btn) {
    const val = input.value.trim();
    if (!val) return;
    try {
      const res = await fetch('/schat/guess', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `team=${teamIdx}&guess=${val}`,
      });
      if (!res.ok) { const d = await res.json(); showToast(d.error || 'Fout'); return; }
      const data = await res.json();
      submittedGuesses[teamIdx] = true;
      btn.textContent = '✓';
      btn.disabled = true;
      btn.classList.add('schat-submitted');
      input.disabled = true;
      input.style.borderColor = TEAM_COLORS[teamIdx];

      // Enable reveal if all teams submitted
      const allDone = gameState.team_names.every((_, i) => submittedGuesses[i]);
      if (allDone) revealBtn.disabled = false;
    } catch { showToast('Netwerkfout'); }
  }

  async function fetchNext() {
    try {
      nextQuestionBtn.disabled = true;
      const res = await fetch('/schat/next', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { const d = await res.json(); showToast(d.error || 'Fout'); nextQuestionBtn.disabled = false; return; }
      const data = await res.json();
      questionText.textContent = data.question;
      roundInfo.textContent = `Vraag ${data.round_number}`;
      renderGuessInputs(gameState);
      revealBtn.disabled = true;
      showPhase('guess');
      nextQuestionBtn.disabled = false;
    } catch { showToast('Netwerkfout'); nextQuestionBtn.disabled = false; }
  }

  async function reveal() {
    try {
      revealBtn.disabled = true;
      const res = await fetch('/schat/reveal', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { const d = await res.json(); showToast(d.error || 'Fout'); revealBtn.disabled = false; return; }
      const data = await res.json();

      revealQuestionText.textContent = questionText.textContent;
      answerValue.textContent = data.answer.toLocaleString('nl-BE');

      // Show guess results
      guessResults.innerHTML = '';
      const answer = data.answer;
      const distances = {};
      gameState.team_names.forEach((_, i) => {
        const g = data.guesses[String(i)];
        if (g !== undefined) distances[i] = Math.abs(g - answer);
      });
      const minDist = Math.min(...Object.values(distances));

      gameState.team_names.forEach((name, i) => {
        const guess = data.guesses[String(i)];
        if (guess === undefined) return;
        const dist = Math.abs(guess - answer);
        const isWinner = dist === minDist;
        const item = document.createElement('div');
        item.className = `schat-result-item ${isWinner ? 'schat-result-winner' : ''}`;
        item.innerHTML = `
          <span class="schat-result-icon">${isWinner ? '✓' : '✗'}</span>
          <span style="flex:1;color:${TEAM_COLORS[i]};font-weight:700">${name}</span>
          <span>${guess.toLocaleString('nl-BE')}</span>
          <span style="color:var(--text-muted);font-size:.8rem">(afstand: ${dist.toLocaleString('nl-BE')})</span>
          <span>${isWinner ? '+1' : '+0'}</span>
        `;
        guessResults.appendChild(item);
      });

      gameState.scores = data.scores;
      updateScoreboard(gameState);

      if (data.winner) {
        winnerText.textContent = `${data.winner} wint! 🏆`;
        setTimeout(() => { winnerOverlay.hidden = false; }, 1000);
      }

      showPhase('reveal');
    } catch { showToast('Netwerkfout'); revealBtn.disabled = false; }
  }

  async function fetchState() {
    try {
      const res = await fetch('/schat/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      gameState = await res.json();
      updateScoreboard(gameState);
      roundInfo.textContent = gameState.round_number ? `Vraag ${gameState.round_number}` : '';
      if (gameState.winner) {
        winnerText.textContent = `${gameState.winner} wint! 🏆`;
        winnerOverlay.hidden = false;
      }
      showPhase('next');
    } catch {}
  }

  nextQuestionBtn.addEventListener('click', fetchNext);
  nextAfterRevealBtn.addEventListener('click', fetchNext);
  revealBtn.addEventListener('click', reveal);

  fetchState();
}

// ---------------------------------------------------------------------------
// Dit of Dat Play page
// ---------------------------------------------------------------------------
function initDodPlay() {
  const dodCard    = document.getElementById('dodCard');
  const dodStart   = document.getElementById('dodStart');
  const optionAText = document.getElementById('optionAText');
  const optionBText = document.getElementById('optionBText');
  const counter    = document.getElementById('dodCounter');
  const nextBtn    = document.getElementById('dodNextBtn');
  const resetBtn   = document.getElementById('dodResetBtn');
  const resetBtn2  = document.getElementById('dodResetBtn2');
  const emptyOverlay = document.getElementById('emptyOverlay');
  const toast      = document.getElementById('toast');

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  async function fetchNext() {
    try {
      nextBtn.disabled = true;
      const res = await fetch('/dod/next', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 204) {
        emptyOverlay.hidden = false;
        nextBtn.disabled = false;
        return;
      }
      if (!res.ok) { showToast('Fout'); nextBtn.disabled = false; return; }
      const data = await res.json();
      dodStart.hidden = true;
      dodCard.hidden = false;
      dodCard.style.animation = 'none';
      dodCard.offsetHeight;
      dodCard.style.animation = '';
      optionAText.textContent = data.option_a;
      optionBText.textContent = data.option_b;
      counter.textContent = `Vraag ${data.number} / ${data.total}`;
      nextBtn.disabled = false;
    } catch { showToast('Netwerkfout'); nextBtn.disabled = false; }
  }

  async function reset() {
    try {
      await fetch('/dod/reset', { method: 'POST', credentials: 'same-origin' });
      dodCard.hidden = true;
      dodStart.hidden = false;
      emptyOverlay.hidden = true;
      counter.textContent = '';
    } catch { showToast('Netwerkfout'); }
  }

  nextBtn.addEventListener('click', fetchNext);
  resetBtn.addEventListener('click', reset);
  if (resetBtn2) resetBtn2.addEventListener('click', reset);
}

// ---------------------------------------------------------------------------
// Bluf Play page
// ---------------------------------------------------------------------------
function initBlufPlay() {
  const TEAM_COLORS = ['#4F46E5', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

  const scoreboard      = document.getElementById('scoreboard');
  const roundInfo       = document.getElementById('roundInfo');
  const phaseNext       = document.getElementById('phaseNext');
  const phaseVote       = document.getElementById('phaseVote');
  const phaseReveal     = document.getElementById('phaseReveal');
  const nextStatementBtn = document.getElementById('nextStatementBtn');
  const statementText   = document.getElementById('statementText');
  const voteSection     = document.getElementById('voteSection');
  const revealBtn       = document.getElementById('revealBtn');
  const revealStatementText = document.getElementById('revealStatementText');
  const answerCard      = document.getElementById('answerCard');
  const answerBadge     = document.getElementById('answerBadge');
  const explanationText = document.getElementById('explanationText');
  const voteResults     = document.getElementById('voteResults');
  const nextAfterRevealBtn = document.getElementById('nextAfterRevealBtn');
  const winnerOverlay   = document.getElementById('winnerOverlay');
  const winnerText      = document.getElementById('winnerText');
  const toast           = document.getElementById('toast');

  let gameState = null;
  let votes = {};

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  function updateScoreboard(st) {
    scoreboard.innerHTML = '';
    st.team_names.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'ts-team-card';
      card.innerHTML = `
        <div class="ts-team-name" style="color:${TEAM_COLORS[i]}">${name}</div>
        <div class="ts-team-position">${st.scores[i]} / ${st.points_to_win}</div>
      `;
      scoreboard.appendChild(card);
    });
  }

  function showPhase(phase) {
    phaseNext.hidden = phase !== 'next';
    phaseVote.hidden = phase !== 'vote';
    phaseReveal.hidden = phase !== 'reveal';
  }

  function renderVoteButtons(st) {
    voteSection.innerHTML = '';
    votes = {};
    st.team_names.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'bluf-team-vote';
      row.innerHTML = `
        <span class="bluf-team-label" style="color:${TEAM_COLORS[i]}">${name}</span>
        <button class="bluf-vote-btn" data-team="${i}" data-vote="true">Waar</button>
        <button class="bluf-vote-btn" data-team="${i}" data-vote="false">Niet waar</button>
        <span class="bluf-vote-check" id="voteCheck${i}"></span>
      `;
      voteSection.appendChild(row);
    });

    voteSection.querySelectorAll('.bluf-vote-btn').forEach(btn => {
      btn.addEventListener('click', () => castVote(btn.dataset.team, btn.dataset.vote));
    });
  }

  async function castVote(teamIdx, vote) {
    try {
      const res = await fetch('/bluf/vote', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `team=${teamIdx}&vote=${vote}`,
      });
      if (!res.ok) return;
      const data = await res.json();
      votes = data.votes;

      // Update vote button styles
      Object.entries(data.votes).forEach(([ti, v]) => {
        const btns = voteSection.querySelectorAll(`[data-team="${ti}"]`);
        btns.forEach(b => {
          b.classList.remove('bluf-voted-true', 'bluf-voted-false');
          if (b.dataset.vote === 'true' && v === true) b.classList.add('bluf-voted-true');
          if (b.dataset.vote === 'false' && v === false) b.classList.add('bluf-voted-false');
        });
        const check = document.getElementById(`voteCheck${ti}`);
        if (check) check.textContent = '✓';
      });

      // Enable reveal if all teams voted
      if (Object.keys(data.votes).length >= gameState.num_teams) {
        revealBtn.disabled = false;
      }
    } catch { showToast('Netwerkfout'); }
  }

  async function fetchNext() {
    try {
      nextStatementBtn.disabled = true;
      const res = await fetch('/bluf/next', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Fout');
        nextStatementBtn.disabled = false;
        return;
      }
      const data = await res.json();
      statementText.textContent = data.statement;
      roundInfo.textContent = `Ronde ${data.round_number}`;
      renderVoteButtons(gameState);
      revealBtn.disabled = true;
      showPhase('vote');
      nextStatementBtn.disabled = false;
    } catch { showToast('Netwerkfout'); nextStatementBtn.disabled = false; }
  }

  async function reveal() {
    try {
      revealBtn.disabled = true;
      const res = await fetch('/bluf/reveal', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { revealBtn.disabled = false; return; }
      const data = await res.json();

      revealStatementText.textContent = statementText.textContent;
      answerCard.className = 'bluf-answer-card ' + (data.answer ? 'bluf-true' : 'bluf-false');
      answerBadge.textContent = data.answer ? '✓ WAAR' : '✗ NIET WAAR';
      explanationText.textContent = data.explanation || '';

      // Show vote results
      voteResults.innerHTML = '';
      data.team_names.forEach((name, i) => {
        const teamVote = votes[String(i)];
        const correct = teamVote === data.answer;
        const item = document.createElement('div');
        item.className = `bluf-result-item ${correct ? 'bluf-result-correct' : 'bluf-result-wrong'}`;
        item.innerHTML = `
          <span class="bluf-result-icon">${correct ? '✓' : '✗'}</span>
          <span style="flex:1;color:${TEAM_COLORS[i]}">${name}</span>
          <span>${teamVote === true ? 'Waar' : teamVote === false ? 'Niet waar' : '–'}</span>
          <span>${correct ? '+1' : '+0'}</span>
        `;
        voteResults.appendChild(item);
      });

      gameState.scores = data.scores;
      updateScoreboard(gameState);

      if (data.winner) {
        winnerText.textContent = `${data.winner} wint! 🏆`;
        setTimeout(() => { winnerOverlay.hidden = false; }, 1000);
      }

      showPhase('reveal');
    } catch { showToast('Netwerkfout'); revealBtn.disabled = false; }
  }

  async function fetchState() {
    try {
      const res = await fetch('/bluf/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      gameState = await res.json();
      updateScoreboard(gameState);
      roundInfo.textContent = gameState.round_number ? `Ronde ${gameState.round_number}` : '';
      if (gameState.winner) {
        winnerText.textContent = `${gameState.winner} wint! 🏆`;
        winnerOverlay.hidden = false;
      }
      showPhase('next');
    } catch {}
  }

  nextStatementBtn.addEventListener('click', fetchNext);
  nextAfterRevealBtn.addEventListener('click', fetchNext);
  revealBtn.addEventListener('click', reveal);

  fetchState();
}

// ---------------------------------------------------------------------------
// Emoji Quiz Play page
// ---------------------------------------------------------------------------
function initEmojiPlay() {
  const emojiCard     = document.getElementById('emojiCard');
  const emojiStart    = document.getElementById('emojiStart');
  const emojiDisplay  = document.getElementById('emojiDisplay');
  const categoryBadge = document.getElementById('categoryBadge');
  const answerSection = document.getElementById('answerSection');
  const emojiAnswer   = document.getElementById('emojiAnswer');
  const counter       = document.getElementById('emojiCounter');
  const nextBtn       = document.getElementById('emojiNextBtn');
  const revealBtn     = document.getElementById('revealBtn');
  const resetBtn      = document.getElementById('emojiResetBtn');
  const resetBtn2     = document.getElementById('emojiResetBtn2');
  const emptyOverlay  = document.getElementById('emptyOverlay');
  const toast         = document.getElementById('toast');

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  async function fetchNext() {
    try {
      nextBtn.disabled = true;
      answerSection.hidden = true;
      revealBtn.hidden = true;
      const res = await fetch('/emoji/next', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 204) {
        emptyOverlay.hidden = false;
        nextBtn.disabled = false;
        return;
      }
      if (!res.ok) { showToast('Fout'); nextBtn.disabled = false; return; }
      const data = await res.json();
      emojiStart.hidden = true;
      emojiCard.hidden = false;
      emojiCard.style.animation = 'none';
      emojiCard.offsetHeight;
      emojiCard.style.animation = '';
      emojiDisplay.textContent = data.emoji;
      categoryBadge.textContent = data.category || '';
      categoryBadge.hidden = !data.category;
      counter.textContent = `Vraag ${data.number} / ${data.total}`;
      revealBtn.hidden = false;
      nextBtn.disabled = false;
    } catch { showToast('Netwerkfout'); nextBtn.disabled = false; }
  }

  async function reveal() {
    try {
      revealBtn.disabled = true;
      const res = await fetch('/emoji/reveal', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { revealBtn.disabled = false; return; }
      const data = await res.json();
      emojiAnswer.textContent = data.answer;
      answerSection.hidden = false;
      revealBtn.hidden = true;
    } catch { showToast('Netwerkfout'); revealBtn.disabled = false; }
  }

  async function reset() {
    try {
      await fetch('/emoji/reset', { method: 'POST', credentials: 'same-origin' });
      emojiCard.hidden = true;
      emojiStart.hidden = false;
      answerSection.hidden = true;
      revealBtn.hidden = true;
      emptyOverlay.hidden = true;
      counter.textContent = '';
    } catch { showToast('Netwerkfout'); }
  }

  nextBtn.addEventListener('click', fetchNext);
  revealBtn.addEventListener('click', reveal);
  resetBtn.addEventListener('click', reset);
  if (resetBtn2) resetBtn2.addEventListener('click', reset);
}

// ---------------------------------------------------------------------------
// Ranking Play page
// ---------------------------------------------------------------------------
function initRankingPlay() {
  const TEAM_COLORS = ['#4F46E5', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

  const scoreboard        = document.getElementById('scoreboard');
  const roundInfo         = document.getElementById('roundInfo');
  const phaseNext         = document.getElementById('phaseNext');
  const phaseDiscuss      = document.getElementById('phaseDiscuss');
  const phaseReveal       = document.getElementById('phaseReveal');
  const nextQuestionBtn   = document.getElementById('nextQuestionBtn');
  const questionText      = document.getElementById('questionText');
  const itemsList         = document.getElementById('itemsList');
  const revealBtn         = document.getElementById('revealBtn');
  const revealQuestionText = document.getElementById('revealQuestionText');
  const correctOrder      = document.getElementById('correctOrder');
  const awardButtons      = document.getElementById('awardButtons');
  const nextAfterRevealBtn = document.getElementById('nextAfterRevealBtn');
  const winnerOverlay     = document.getElementById('winnerOverlay');
  const winnerText        = document.getElementById('winnerText');
  const toast             = document.getElementById('toast');

  let gameState = null;

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  function showPhase(phase) {
    phaseNext.hidden = phase !== 'next';
    phaseDiscuss.hidden = phase !== 'discuss';
    phaseReveal.hidden = phase !== 'reveal';
  }

  function updateScoreboard(st) {
    scoreboard.innerHTML = '';
    st.team_names.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'ts-team-card';
      card.innerHTML = `
        <div class="ts-team-name" style="color:${TEAM_COLORS[i]}">${name}</div>
        <div class="ts-team-position">${st.scores[i]} / ${st.points_to_win}</div>
      `;
      scoreboard.appendChild(card);
    });
  }

  function renderItems(items) {
    itemsList.innerHTML = '';
    items.forEach((name, i) => {
      const item = document.createElement('div');
      item.className = 'ranking-item';
      item.innerHTML = `
        <span class="ranking-item-number">${i + 1}</span>
        <span>${name}</span>
      `;
      itemsList.appendChild(item);
    });
  }

  function renderCorrectOrder(correct) {
    correctOrder.innerHTML = '';
    correct.forEach((name, i) => {
      const item = document.createElement('div');
      item.className = 'ranking-correct-item';
      item.style.animationDelay = (i * 0.1) + 's';
      item.innerHTML = `
        <span class="ranking-correct-number">${i + 1}</span>
        <span>${name}</span>
      `;
      correctOrder.appendChild(item);
    });
  }

  function renderAwardButtons(st) {
    awardButtons.innerHTML = '';
    st.team_names.forEach((name, i) => {
      const btn = document.createElement('button');
      btn.className = 'ranking-award-btn';
      btn.style.color = TEAM_COLORS[i];
      btn.style.borderColor = TEAM_COLORS[i];
      btn.textContent = `+1 ${name}`;
      btn.addEventListener('click', () => awardPoint(i, btn));
      awardButtons.appendChild(btn);
    });
  }

  async function awardPoint(teamIdx, btn) {
    try {
      const res = await fetch('/ranking/award', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `team=${teamIdx}`,
      });
      if (!res.ok) return;
      const data = await res.json();
      btn.classList.add('awarded');
      btn.textContent = '✓ Punt gegeven';
      btn.disabled = true;
      gameState.scores = data.scores;
      updateScoreboard(gameState);

      if (data.winner) {
        winnerText.textContent = `${data.winner} wint! 🏆`;
        setTimeout(() => { winnerOverlay.hidden = false; }, 1000);
      }
    } catch { showToast('Netwerkfout'); }
  }

  async function fetchNext() {
    try {
      nextQuestionBtn.disabled = true;
      const res = await fetch('/ranking/next', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { const d = await res.json(); showToast(d.error || 'Fout'); nextQuestionBtn.disabled = false; return; }
      const data = await res.json();
      questionText.textContent = data.question;
      roundInfo.textContent = `Ronde ${data.round_number}`;
      renderItems(data.items);
      showPhase('discuss');
      nextQuestionBtn.disabled = false;
    } catch { showToast('Netwerkfout'); nextQuestionBtn.disabled = false; }
  }

  async function reveal() {
    try {
      revealBtn.disabled = true;
      const res = await fetch('/ranking/reveal', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { revealBtn.disabled = false; return; }
      const data = await res.json();

      revealQuestionText.textContent = questionText.textContent;
      renderCorrectOrder(data.correct_order);
      renderAwardButtons(gameState);

      if (data.winner) {
        winnerText.textContent = `${data.winner} wint! 🏆`;
        setTimeout(() => { winnerOverlay.hidden = false; }, 1000);
      }

      showPhase('reveal');
      revealBtn.disabled = false;
    } catch { showToast('Netwerkfout'); revealBtn.disabled = false; }
  }

  async function fetchState() {
    try {
      const res = await fetch('/ranking/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      gameState = await res.json();
      updateScoreboard(gameState);
      roundInfo.textContent = gameState.round_number ? `Ronde ${gameState.round_number}` : '';
      if (gameState.winner) {
        winnerText.textContent = `${gameState.winner} wint! 🏆`;
        winnerOverlay.hidden = false;
      }
      showPhase('next');
    } catch {}
  }

  nextQuestionBtn.addEventListener('click', fetchNext);
  nextAfterRevealBtn.addEventListener('click', fetchNext);
  revealBtn.addEventListener('click', reveal);

  fetchState();
}

// ---------------------------------------------------------------------------
// Categories Play page
// ---------------------------------------------------------------------------
function initCatPlay() {
  const catCard     = document.getElementById('catCard');
  const catStart    = document.getElementById('catStart');
  const catLetter   = document.getElementById('catLetter');
  const catCategory = document.getElementById('catCategory');
  const catTimer    = document.getElementById('catTimer');
  const timerText   = document.getElementById('timerText');
  const timerProgress = document.getElementById('timerProgress');
  const counter     = document.getElementById('catCounter');
  const nextBtn     = document.getElementById('catNextBtn');
  const timerBtn    = document.getElementById('timerBtn');
  const resetBtn    = document.getElementById('catResetBtn');
  const resetBtn2   = document.getElementById('catResetBtn2');
  const emptyOverlay = document.getElementById('emptyOverlay');
  const toast       = document.getElementById('toast');

  let timerInterval = null;
  let timeLeft = 30;
  const CIRCUMFERENCE = 2 * Math.PI * 45; // r=45 from SVG

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function startTimer() {
    stopTimer();
    timeLeft = 30;
    catTimer.hidden = false;
    timerText.textContent = '30';
    timerProgress.style.strokeDashoffset = '0';
    timerProgress.classList.remove('warning', 'danger');
    timerBtn.hidden = true;

    timerInterval = setInterval(() => {
      timeLeft--;
      timerText.textContent = timeLeft;
      const offset = CIRCUMFERENCE * (1 - timeLeft / 30);
      timerProgress.style.strokeDashoffset = offset;

      if (timeLeft <= 5) {
        timerProgress.classList.remove('warning');
        timerProgress.classList.add('danger');
      } else if (timeLeft <= 10) {
        timerProgress.classList.add('warning');
      }

      if (timeLeft <= 0) {
        stopTimer();
        showToast('⏰ Tijd is om!');
      }
    }, 1000);
  }

  async function fetchNext() {
    try {
      stopTimer();
      nextBtn.disabled = true;
      catTimer.hidden = true;
      const res = await fetch('/cat/next', { method: 'POST', credentials: 'same-origin' });
      if (res.status === 204) {
        emptyOverlay.hidden = false;
        nextBtn.disabled = false;
        return;
      }
      if (!res.ok) { showToast('Fout'); nextBtn.disabled = false; return; }
      const data = await res.json();
      catStart.hidden = true;
      catCard.hidden = false;
      catCard.style.animation = 'none';
      catCard.offsetHeight;
      catCard.style.animation = '';
      catLetter.textContent = data.letter;
      catCategory.textContent = data.category;
      counter.textContent = `Kaart ${data.number} / ${data.total}`;
      timerBtn.hidden = false;
      nextBtn.disabled = false;
    } catch { showToast('Netwerkfout'); nextBtn.disabled = false; }
  }

  async function reset() {
    try {
      stopTimer();
      await fetch('/cat/reset', { method: 'POST', credentials: 'same-origin' });
      catCard.hidden = true;
      catStart.hidden = false;
      catTimer.hidden = true;
      timerBtn.hidden = true;
      emptyOverlay.hidden = true;
      counter.textContent = '';
    } catch { showToast('Netwerkfout'); }
  }

  nextBtn.addEventListener('click', fetchNext);
  timerBtn.addEventListener('click', startTimer);
  resetBtn.addEventListener('click', reset);
  if (resetBtn2) resetBtn2.addEventListener('click', reset);
}

// ---------------------------------------------------------------------------
// Timeline Play page
// ---------------------------------------------------------------------------
function initTlPlay() {
  const TEAM_COLORS = ['#4F46E5', '#EF4444', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899'];

  const scoreboard        = document.getElementById('scoreboard');
  const roundInfo         = document.getElementById('roundInfo');
  const phaseNext         = document.getElementById('phaseNext');
  const phaseGuess        = document.getElementById('phaseGuess');
  const phaseReveal       = document.getElementById('phaseReveal');
  const nextEventBtn      = document.getElementById('nextEventBtn');
  const eventText         = document.getElementById('eventText');
  const guessSection      = document.getElementById('guessSection');
  const revealBtn         = document.getElementById('revealBtn');
  const revealEventText   = document.getElementById('revealEventText');
  const yearValue         = document.getElementById('yearValue');
  const guessResults      = document.getElementById('guessResults');
  const nextAfterRevealBtn = document.getElementById('nextAfterRevealBtn');
  const winnerOverlay     = document.getElementById('winnerOverlay');
  const winnerText        = document.getElementById('winnerText');
  const toast             = document.getElementById('toast');

  let gameState = null;
  let submittedGuesses = {};

  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 2500);
  }

  function showPhase(phase) {
    phaseNext.hidden = phase !== 'next';
    phaseGuess.hidden = phase !== 'guess';
    phaseReveal.hidden = phase !== 'reveal';
  }

  function updateScoreboard(st) {
    scoreboard.innerHTML = '';
    st.team_names.forEach((name, i) => {
      const card = document.createElement('div');
      card.className = 'ts-team-card';
      card.innerHTML = `
        <div class="ts-team-name" style="color:${TEAM_COLORS[i]}">${name}</div>
        <div class="ts-team-position">${st.scores[i]} / ${st.points_to_win}</div>
      `;
      scoreboard.appendChild(card);
    });
  }

  function renderGuessInputs(st) {
    guessSection.innerHTML = '';
    submittedGuesses = {};
    st.team_names.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'tl-team-guess';
      row.innerHTML = `
        <span class="tl-team-label" style="color:${TEAM_COLORS[i]}">${name}</span>
        <input type="number" class="tl-guess-input" id="tlGuessInput${i}" placeholder="Jaar..." step="1">
        <button class="tl-submit-btn" id="tlGuessBtn${i}" data-team="${i}">✓</button>
      `;
      guessSection.appendChild(row);

      const btn = row.querySelector(`#tlGuessBtn${i}`);
      const input = row.querySelector(`#tlGuessInput${i}`);
      btn.addEventListener('click', () => submitGuess(i, input, btn));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitGuess(i, input, btn);
      });
    });
  }

  async function submitGuess(teamIdx, input, btn) {
    const val = input.value.trim();
    if (!val) return;
    try {
      const res = await fetch('/tl/guess', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `team=${teamIdx}&guess=${val}`,
      });
      if (!res.ok) { const d = await res.json(); showToast(d.error || 'Fout'); return; }
      submittedGuesses[teamIdx] = true;
      btn.textContent = '✓';
      btn.disabled = true;
      btn.classList.add('tl-submitted');
      input.disabled = true;
      input.style.borderColor = TEAM_COLORS[teamIdx];

      const allDone = gameState.team_names.every((_, i) => submittedGuesses[i]);
      if (allDone) revealBtn.disabled = false;
    } catch { showToast('Netwerkfout'); }
  }

  async function fetchNext() {
    try {
      nextEventBtn.disabled = true;
      const res = await fetch('/tl/next', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { const d = await res.json(); showToast(d.error || 'Fout'); nextEventBtn.disabled = false; return; }
      const data = await res.json();
      eventText.textContent = data.event;
      roundInfo.textContent = `Evenement ${data.round_number}`;
      renderGuessInputs(gameState);
      revealBtn.disabled = true;
      showPhase('guess');
      nextEventBtn.disabled = false;
    } catch { showToast('Netwerkfout'); nextEventBtn.disabled = false; }
  }

  async function reveal() {
    try {
      revealBtn.disabled = true;
      const res = await fetch('/tl/reveal', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) { const d = await res.json(); showToast(d.error || 'Fout'); revealBtn.disabled = false; return; }
      const data = await res.json();

      revealEventText.textContent = eventText.textContent;
      yearValue.textContent = data.year;

      guessResults.innerHTML = '';
      const year = data.year;
      const distances = {};
      gameState.team_names.forEach((_, i) => {
        const g = data.guesses[String(i)];
        if (g !== undefined) distances[i] = Math.abs(g - year);
      });
      const minDist = Math.min(...Object.values(distances));

      gameState.team_names.forEach((name, i) => {
        const guess = data.guesses[String(i)];
        if (guess === undefined) return;
        const dist = Math.abs(guess - year);
        const isWinner = dist === minDist;
        const item = document.createElement('div');
        item.className = `tl-result-item ${isWinner ? 'tl-result-winner' : ''}`;
        item.innerHTML = `
          <span class="tl-result-icon">${isWinner ? '✓' : '✗'}</span>
          <span style="flex:1;color:${TEAM_COLORS[i]};font-weight:700">${name}</span>
          <span>${guess}</span>
          <span style="color:var(--text-muted);font-size:.8rem">(verschil: ${dist} jaar)</span>
          <span>${isWinner ? '+1' : '+0'}</span>
        `;
        guessResults.appendChild(item);
      });

      gameState.scores = data.scores;
      updateScoreboard(gameState);

      if (data.winner) {
        winnerText.textContent = `${data.winner} wint! 🏆`;
        setTimeout(() => { winnerOverlay.hidden = false; }, 1000);
      }

      showPhase('reveal');
    } catch { showToast('Netwerkfout'); revealBtn.disabled = false; }
  }

  async function fetchState() {
    try {
      const res = await fetch('/tl/state', { credentials: 'same-origin' });
      if (!res.ok) return;
      gameState = await res.json();
      updateScoreboard(gameState);
      roundInfo.textContent = gameState.round_number ? `Evenement ${gameState.round_number}` : '';
      if (gameState.winner) {
        winnerText.textContent = `${gameState.winner} wint! 🏆`;
        winnerOverlay.hidden = false;
      }
      showPhase('next');
    } catch {}
  }

  nextEventBtn.addEventListener('click', fetchNext);
  nextAfterRevealBtn.addEventListener('click', fetchNext);
  revealBtn.addEventListener('click', reveal);

  fetchState();
}

// ---------------------------------------------------------------------------
// Floating party particles (home page only)
// ---------------------------------------------------------------------------
function initParticles() {
  if (!document.querySelector('.game-picker')) return;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.4';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let W, H;

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const COLORS = ['#6366F1', '#EC4899', '#F59E0B', '#14B8A6', '#8B5CF6', '#EF4444', '#10B981'];
  const particles = Array.from({ length: 30 }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    r: Math.random() * 3 + 1,
    dx: (Math.random() - .5) * .4,
    dy: (Math.random() - .5) * .3 - .15,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    alpha: Math.random() * .5 + .2,
  }));

  function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      p.x += p.dx;
      p.y += p.dy;
      if (p.x < -10) p.x = W + 10;
      if (p.x > W + 10) p.x = -10;
      if (p.y < -10) p.y = H + 10;
      if (p.y > H + 10) p.y = -10;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
}

// ---------------------------------------------------------------------------
// Confetti burst (used on win screens)
// ---------------------------------------------------------------------------
function launchConfetti(count = 60) {
  const COLORS = ['#6366F1', '#EC4899', '#F59E0B', '#14B8A6', '#8B5CF6', '#EF4444', '#10B981', '#3B82F6'];
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = COLORS[Math.floor(Math.random() * COLORS.length)];
    el.style.width = (Math.random() * 8 + 4) + 'px';
    el.style.height = (Math.random() * 8 + 4) + 'px';
    el.style.borderRadius = Math.random() > .5 ? '50%' : '2px';
    el.style.animationDuration = (Math.random() * 2 + 2) + 's';
    el.style.animationDelay = (Math.random() * .8) + 's';
    el.style.opacity = '0';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }
}

// Auto-trigger confetti on winner overlays
(function watchWinnerOverlays() {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'hidden') {
        const el = m.target;
        if (el.id && el.id.includes('winner') && !el.hidden) {
          launchConfetti();
        }
      }
    }
  });
  document.querySelectorAll('[id*="winner"]').forEach(el => {
    observer.observe(el, { attributes: true, attributeFilter: ['hidden'] });
  });
})();

// ---------------------------------------------------------------------------
// Runner (Dino-style endless runner) – multiplayer canvas game (1-4 players)
// ---------------------------------------------------------------------------
function initRunnerPlay() {
  const canvas = document.getElementById('runnerCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('runnerOverlay');
  const msgEl = document.getElementById('runnerMsg');
  const hudEl = document.getElementById('runnerHud');
  const controlsEl = document.getElementById('runnerControls');
  const setupEl = document.getElementById('runnerSetup');
  const gameEl = document.getElementById('runnerGame');
  const backBtn = document.getElementById('runnerBackBtn');

  // --- Player config: colors & key bindings ---
  const PLAYER_CFG = [
    { color: '#22C55E', name: 'Speler 1', jump: 'KeyW',      duck: 'KeyS',       jumpLabel: 'W', duckLabel: 'S' },
    { color: '#3B82F6', name: 'Speler 2', jump: 'ArrowUp',   duck: 'ArrowDown',  jumpLabel: '↑', duckLabel: '↓' },
    { color: '#F59E0B', name: 'Speler 3', jump: 'KeyI',      duck: 'KeyK',       jumpLabel: 'I', duckLabel: 'K' },
    { color: '#EC4899', name: 'Speler 4', jump: 'Numpad8',   duck: 'Numpad5',    jumpLabel: 'Num8', duckLabel: 'Num5' },
  ];

  // --- Constants ---
  const W = 700;
  const GRAVITY = 0.6;
  const JUMP_FORCE = -11;
  const DUCK_SHRINK = 16;
  const INITIAL_SPEED = 5;
  const MAX_SPEED = 14;
  const ACCEL = 0.002;
  const MIN_GAP = 55;

  let numPlayers = 0;
  let laneH, H;

  // Theme-aware colors
  function colors() {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    return {
      bg: dark ? '#0f172a' : '#f1f5f9',
      ground: dark ? '#334155' : '#cbd5e1',
      groundLine: dark ? '#475569' : '#94a3b8',
      obstacle: '#EF4444',
      obstacleBird: '#F59E0B',
      cloud: dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.06)',
      text: dark ? '#e2e8f0' : '#1e293b',
      laneDivider: dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)',
      deadOverlay: 'rgba(239,68,68,.12)',
    };
  }

  // --- Per-player state ---
  let players = [];
  let speed, frameCount, globalClouds;
  let state = 'idle'; // idle | running | done

  function makeLaneState(idx) {
    const groundY = laneH - 24;
    return {
      idx,
      alive: true,
      dino: { x: 50, y: groundY, w: 24, h: 30, vy: 0, ducking: false, frame: 0 },
      obstacles: [],
      particles: [],
      score: 0,
      groundY,
      finalScore: 0,
    };
  }

  function resetAll() {
    players = [];
    for (let i = 0; i < numPlayers; i++) players.push(makeLaneState(i));
    speed = INITIAL_SPEED;
    frameCount = 0;
    globalClouds = [];
    for (let i = 0; i < 3; i++) {
      globalClouds.push({ x: 150 + i * 220, y: 20 + Math.random() * 30, w: 45 + Math.random() * 25 });
    }
  }

  // --- Drawing helpers (per-lane, with y offset) ---
  function drawLaneGround(c, yOff, groundY) {
    ctx.fillStyle = c.ground;
    ctx.fillRect(0, yOff + groundY, W, laneH - groundY);
    ctx.strokeStyle = c.groundLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, yOff + groundY);
    ctx.lineTo(W, yOff + groundY);
    ctx.stroke();
    for (let i = 0; i < W; i += 20) {
      const offset = (frameCount * speed) % 20;
      const x = i - offset;
      if (x >= 0 && x < W) {
        ctx.fillStyle = c.groundLine;
        ctx.fillRect(x, yOff + groundY + 6 + (i % 40 === 0 ? 3 : 0), 7, 1.5);
      }
    }
  }

  function drawLaneDino(c, p, yOff, pColor) {
    const d = p.dino;
    const groundY = p.groundY;
    const h = d.ducking ? d.h - DUCK_SHRINK : d.h;
    const y = d.ducking ? d.y + DUCK_SHRINK : d.y;
    const bx = d.x;
    const by = yOff + y - h;

    ctx.fillStyle = pColor;
    ctx.beginPath();
    ctx.roundRect(bx, by, d.w, h, 3);
    ctx.fill();

    // Eye
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    ctx.fillStyle = dark ? '#0f172a' : '#fff';
    ctx.fillRect(bx + d.w - 7, by + 4, 3, 3);

    // Legs
    const legOff = Math.sin(d.frame * 0.3) * 3;
    ctx.fillStyle = pColor;
    if (d.y < groundY) {
      ctx.fillRect(bx + 3, yOff + y, 4, 3);
      ctx.fillRect(bx + 14, yOff + y, 4, 3);
    } else {
      ctx.fillRect(bx + 3, yOff + y, 4, 5 + legOff);
      ctx.fillRect(bx + 14, yOff + y, 4, 5 - legOff);
    }
  }

  function drawLaneObstacles(c, p, yOff) {
    const groundY = p.groundY;
    for (const ob of p.obstacles) {
      if (ob.type === 'cactus') {
        ctx.fillStyle = c.obstacle;
        ctx.beginPath();
        ctx.roundRect(ob.x, yOff + groundY - ob.h, ob.w, ob.h, 2);
        ctx.fill();
        if (ob.h > 20) {
          ctx.fillRect(ob.x - 3, yOff + groundY - ob.h + 5, 3, 6);
          ctx.fillRect(ob.x + ob.w, yOff + groundY - ob.h + 8, 3, 6);
        }
      } else {
        ctx.fillStyle = c.obstacleBird;
        const by = yOff + ob.y;
        ctx.beginPath();
        ctx.ellipse(ob.x + ob.w / 2, by, ob.w / 2, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        const wingOff = Math.sin(frameCount * 0.25) * 4;
        ctx.beginPath();
        ctx.moveTo(ob.x + 3, by);
        ctx.lineTo(ob.x + ob.w / 2, by - 8 - wingOff);
        ctx.lineTo(ob.x + ob.w - 3, by);
        ctx.fill();
      }
    }
  }

  function drawLaneParticles(pColor, p, yOff) {
    for (const pt of p.particles) {
      ctx.globalAlpha = pt.life;
      ctx.fillStyle = pColor;
      ctx.fillRect(pt.x, yOff + pt.y, 2.5, 2.5);
    }
    ctx.globalAlpha = 1;
  }

  function drawClouds(c) {
    ctx.fillStyle = c.cloud;
    for (const cl of globalClouds) {
      ctx.beginPath();
      ctx.ellipse(cl.x, cl.y, cl.w / 2, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cl.x - 10, cl.y + 3, cl.w / 3, 6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawLaneLabel(p, yOff, pColor) {
    ctx.fillStyle = pColor;
    ctx.globalAlpha = 0.7;
    ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(PLAYER_CFG[p.idx].name, 6, yOff + 14);
    ctx.globalAlpha = 1;
  }

  function drawLaneScore(c, p, yOff) {
    ctx.fillStyle = c.text;
    ctx.font = 'bold 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.floor(p.score)).padStart(5, '0'), W - 10, yOff + 14);
  }

  // --- Spawn obstacles per lane ---
  function trySpawnObstacle(p) {
    if (p.obstacles.length > 0) {
      const last = p.obstacles[p.obstacles.length - 1];
      if (last.x > W - MIN_GAP * speed) return;
    }
    const gap = MIN_GAP + Math.random() * 100;
    const spawnX = W + gap;
    const groundY = p.groundY;

    if (speed > 7 && Math.random() < 0.2) {
      const birdY = groundY - 25 - Math.random() * 20;
      p.obstacles.push({ type: 'bird', x: spawnX, y: birdY, w: 22, h: 10 });
    } else {
      const variant = Math.random();
      let w, h;
      if (variant < 0.3) { w = 10; h = 16 + Math.random() * 8; }
      else if (variant < 0.7) { w = 14; h = 22 + Math.random() * 10; }
      else { w = 20; h = 26 + Math.random() * 10; }
      p.obstacles.push({ type: 'cactus', x: spawnX, y: groundY, w, h });
    }
  }

  // --- Collision per lane ---
  function checkCollision(p) {
    const d = p.dino;
    const groundY = p.groundY;
    const dh = d.ducking ? d.h - DUCK_SHRINK : d.h;
    const dy = d.ducking ? d.y + DUCK_SHRINK : d.y;
    const dx1 = d.x + 3, dx2 = d.x + d.w - 3;
    const dy1 = dy - dh + 3, dy2 = dy;

    for (const ob of p.obstacles) {
      let ox1, ox2, oy1, oy2;
      if (ob.type === 'cactus') {
        ox1 = ob.x + 2; ox2 = ob.x + ob.w - 2;
        oy1 = groundY - ob.h + 2; oy2 = groundY;
      } else {
        ox1 = ob.x + 2; ox2 = ob.x + ob.w - 2;
        oy1 = ob.y - 5; oy2 = ob.y + 5;
      }
      if (dx1 < ox2 && dx2 > ox1 && dy1 < oy2 && dy2 > oy1) return true;
    }
    return false;
  }

  function spawnDeathParticles(p) {
    const pColor = PLAYER_CFG[p.idx].color;
    for (let i = 0; i < 8; i++) {
      p.particles.push({
        x: p.dino.x + p.dino.w / 2,
        y: p.dino.y - p.dino.h / 2,
        vx: (Math.random() - 0.5) * 5,
        vy: (Math.random() - 1) * 4,
        life: 1,
      });
    }
  }

  // --- HUD ---
  function buildHud() {
    let html = '';
    for (let i = 0; i < numPlayers; i++) {
      const cfg = PLAYER_CFG[i];
      html += '<span class="runner-score" style="border-color:' + cfg.color + ';color:' + cfg.color + '">' +
        cfg.name + ': <strong id="rScore' + i + '">0</strong></span>';
    }
    hudEl.innerHTML = html;
  }

  function buildControls() {
    let html = '';
    for (let i = 0; i < numPlayers; i++) {
      const cfg = PLAYER_CFG[i];
      if (i > 0) html += ' &nbsp;·&nbsp; ';
      html += '<span style="color:' + cfg.color + ';font-weight:600">' + cfg.name + '</span>: ' +
        '<span>' + cfg.jumpLabel + '</span> spring · <span>' + cfg.duckLabel + '</span> buk';
    }
    controlsEl.innerHTML = html;
  }

  function updateHudScores() {
    for (let i = 0; i < numPlayers; i++) {
      const el = document.getElementById('rScore' + i);
      if (el) el.textContent = Math.floor(players[i].score);
    }
  }

  // --- Game loop ---
  function update() {
    if (state !== 'running') return;

    frameCount++;
    speed = Math.min(MAX_SPEED, INITIAL_SPEED + frameCount * ACCEL);

    let anyAlive = false;
    for (const p of players) {
      if (!p.alive) continue;
      anyAlive = true;
      p.score += speed * 0.02;

      // Dino physics
      const groundY = p.groundY;
      if (p.dino.y < groundY || p.dino.vy < 0) {
        p.dino.vy += GRAVITY;
        p.dino.y += p.dino.vy;
        if (p.dino.y >= groundY) { p.dino.y = groundY; p.dino.vy = 0; }
      }
      p.dino.frame++;

      // Move obstacles
      for (const ob of p.obstacles) ob.x -= speed;
      p.obstacles = p.obstacles.filter(ob => ob.x + ob.w > -20);
      trySpawnObstacle(p);

      // Collision
      if (checkCollision(p)) {
        p.alive = false;
        p.finalScore = Math.floor(p.score);
        spawnDeathParticles(p);
      }
    }

    // Particles for dead players
    for (const p of players) {
      for (const pt of p.particles) {
        pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.15; pt.life -= 0.03;
      }
      p.particles = p.particles.filter(pt => pt.life > 0);
    }

    // Clouds
    for (const cl of globalClouds) cl.x -= speed * 0.2;
    globalClouds = globalClouds.filter(cl => cl.x + cl.w > -60);
    if (globalClouds.length < 3 && Math.random() < 0.01) {
      globalClouds.push({ x: W + 30, y: 15 + Math.random() * 35, w: 35 + Math.random() * 30 });
    }

    updateHudScores();

    if (!anyAlive) {
      state = 'done';
      showResults();
    }
  }

  function draw() {
    const c = colors();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);

    drawClouds(c);

    for (let i = 0; i < numPlayers; i++) {
      const p = players[i];
      const yOff = i * laneH;
      const cfg = PLAYER_CFG[i];

      // Lane divider
      if (i > 0) {
        ctx.strokeStyle = c.laneDivider;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, yOff);
        ctx.lineTo(W, yOff);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Dead overlay
      if (!p.alive) {
        ctx.fillStyle = c.deadOverlay;
        ctx.fillRect(0, yOff, W, laneH);
      }

      drawLaneGround(c, yOff, p.groundY);
      drawLaneObstacles(c, p, yOff);
      if (p.alive) drawLaneDino(c, p, yOff, cfg.color);
      drawLaneParticles(cfg.color, p, yOff);
      drawLaneLabel(p, yOff, cfg.color);
      drawLaneScore(c, p, yOff);
    }
  }

  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  // --- Results ---
  function showResults() {
    const sorted = [...players].sort((a, b) => b.finalScore - a.finalScore);
    const winner = sorted[0];
    const cfg = PLAYER_CFG[winner.idx];

    let html = '<span class="runner-big" style="color:' + cfg.color + '">' +
      (numPlayers > 1 ? '🏆 ' + cfg.name + ' wint!' : 'Game Over!') + '</span>';
    if (numPlayers > 1) {
      html += '<span class="runner-sub">';
      for (const p of sorted) {
        html += PLAYER_CFG[p.idx].name + ': ' + p.finalScore + ' &nbsp; ';
      }
      html += '</span>';
    } else {
      html += '<span class="runner-sub">Score: ' + winner.finalScore + '</span>';
      // Update high score for solo
      const hs = parseInt(localStorage.getItem('runner_high') || '0', 10);
      if (winner.finalScore > hs) localStorage.setItem('runner_high', String(winner.finalScore));
    }
    html += '<span class="runner-sub" style="margin-top:.5rem;opacity:.7">Druk op een spring-toets om opnieuw te spelen</span>';

    setTimeout(() => {
      overlay.classList.remove('hidden');
      msgEl.innerHTML = html;
    }, 500);
  }

  // --- State transitions ---
  function startGame() {
    resetAll();
    state = 'running';
    overlay.classList.add('hidden');
  }

  // --- Input ---
  const keysDown = new Set();

  document.addEventListener('keydown', (e) => {
    if (keysDown.has(e.code)) return;
    keysDown.add(e.code);

    for (let i = 0; i < numPlayers; i++) {
      const cfg = PLAYER_CFG[i];
      if (e.code === cfg.jump) {
        e.preventDefault();
        if (state === 'idle' || state === 'done') { startGame(); return; }
        const p = players[i];
        if (p && p.alive && p.dino.y >= p.groundY && p.dino.vy === 0) {
          p.dino.vy = JUMP_FORCE;
        }
      }
      if (e.code === cfg.duck) {
        e.preventDefault();
        if (state === 'running' && players[i] && players[i].alive) {
          players[i].dino.ducking = true;
        }
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    keysDown.delete(e.code);
    for (let i = 0; i < numPlayers; i++) {
      const cfg = PLAYER_CFG[i];
      if (e.code === cfg.duck && players[i]) {
        players[i].dino.ducking = false;
      }
    }
  });

  // Touch on canvas = jump player 1
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (state === 'idle' || state === 'done') { startGame(); return; }
    if (players[0] && players[0].alive && players[0].dino.y >= players[0].groundY && players[0].dino.vy === 0) {
      players[0].dino.vy = JUMP_FORCE;
    }
  });

  // --- Player count selection ---
  function initWithPlayers(n) {
    numPlayers = n;
    // Adjust canvas height: more lanes = taller
    laneH = n === 1 ? 180 : (n === 2 ? 130 : (n === 3 ? 110 : 95));
    H = laneH * n;
    canvas.height = H;

    setupEl.hidden = true;
    gameEl.hidden = false;

    buildHud();
    buildControls();
    resetAll();
    state = 'idle';

    // Show start overlay
    overlay.classList.remove('hidden');
    let startHint = numPlayers === 1
      ? '<span class="runner-big">Druk op <kbd>W</kbd> of tik om te starten</span>'
      : '<span class="runner-big">Klaar? Druk op een spring-toets!</span>';
    msgEl.innerHTML = startHint;

    loop();
  }

  document.querySelectorAll('.runner-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      initWithPlayers(parseInt(btn.dataset.players, 10));
    });
  });

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      state = 'idle';
      setupEl.hidden = false;
      gameEl.hidden = true;
    });
  }
}

// ---------------------------------------------------------------------------
// Arena – 2D top-down shooter, 1-4 players, shared keyboard
// ---------------------------------------------------------------------------
function initArenaPlay() {
  const canvas = document.getElementById('arenaCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('arenaOverlay');
  const msgEl = document.getElementById('arenaMsg');
  const hudEl = document.getElementById('arenaHud');
  const controlsEl = document.getElementById('arenaControls');
  const setupEl = document.getElementById('arenaSetup');
  const gameEl = document.getElementById('arenaGame');
  const startBtn = document.getElementById('arenaStartBtn');
  const backBtn = document.getElementById('arenaBackBtn');

  const W = canvas.width;  // 700
  const H = canvas.height; // 500

  // ===================== AUDIO ENGINE =====================
  let audioCtx = null;
  function ensureAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); return audioCtx; }
  function playTone(freq, dur, vol, type) {
    try {
      const ac = ensureAudio();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = type || 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol || 0.08, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + dur);
      osc.connect(gain); gain.connect(ac.destination);
      osc.start(); osc.stop(ac.currentTime + dur);
    } catch(e) {}
  }
  function sfxShoot()   { playTone(600, 0.06, 0.05, 'square'); }
  function sfxHit()     { playTone(200, 0.08, 0.06, 'sawtooth'); }
  function sfxKill()    { playTone(800, 0.12, 0.07, 'square'); }
  function sfxPickup()  { playTone(1200, 0.1, 0.06, 'sine'); setTimeout(() => playTone(1500, 0.1, 0.06, 'sine'), 60); }
  function sfxDamage()  { playTone(120, 0.2, 0.1, 'sawtooth'); }
  function sfxDeath()   { playTone(80, 0.4, 0.12, 'sawtooth'); }
  function sfxBoss()    { playTone(100, 0.5, 0.1, 'square'); setTimeout(() => playTone(150, 0.3, 0.08, 'square'), 200); }
  function sfxWave()    { playTone(440, 0.15, 0.06, 'sine'); setTimeout(() => playTone(660, 0.15, 0.06, 'sine'), 100); setTimeout(() => playTone(880, 0.2, 0.06, 'sine'), 200); }
  function sfxDash()    { playTone(400, 0.08, 0.05, 'triangle'); playTone(800, 0.08, 0.04, 'triangle'); }
  function sfxCombo()   { playTone(1000, 0.06, 0.04, 'sine'); }

  // ===================== PLAYER CONFIGS =====================
  const PCFG = [
    { color: '#22C55E', name: 'Speler 1', up:'KeyW', down:'KeyS', left:'KeyA', right:'KeyD', shoot:'KeyQ', dash:'KeyE',
      upL:'W', downL:'S', leftL:'A', rightL:'D', shootL:'Q', dashL:'E' },
    { color: '#3B82F6', name: 'Speler 2', up:'ArrowUp', down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight', shoot:'Slash', dash:'Period',
      upL:'↑', downL:'↓', leftL:'←', rightL:'→', shootL:'/', dashL:'.' },
    { color: '#F59E0B', name: 'Speler 3', up:'KeyI', down:'KeyK', left:'KeyJ', right:'KeyL', shoot:'KeyU', dash:'KeyO',
      upL:'I', downL:'K', leftL:'J', rightL:'L', shootL:'U', dashL:'O' },
    { color: '#EC4899', name: 'Speler 4', up:'Numpad8', down:'Numpad5', left:'Numpad4', right:'Numpad6', shoot:'Numpad0', dash:'NumpadDecimal',
      upL:'Num8', downL:'Num5', leftL:'Num4', rightL:'Num6', shootL:'Num0', dashL:'Num.' },
  ];

  // ===================== CONSTANTS =====================
  const PLAYER_SPEED = 3.2;
  const PLAYER_R = 12;
  const BULLET_SPEED = 7;
  const BULLET_R = 3;
  const BULLET_COOLDOWN = 12;
  const ENEMY_R = 10;
  const INVULN_FRAMES = 60;
  const POWERUP_R = 10;
  const POWERUP_DURATION_MIN = 600;
  const POWERUP_DURATION_MAX = 1800;
  const DASH_SPEED = 12;
  const DASH_DURATION = 8;   // frames of dash
  const DASH_COOLDOWN = 180; // 3 seconds
  const COMBO_WINDOW = 120;  // 2 seconds
  const WAVE_BREATHER = 180; // 3 seconds between waves

  // ===================== ENEMY TYPES =====================
  const ENEMY_TYPES = [
    { id: 'normal',  color: '#EF4444', r: 10, hp: 1, speedMul: 1.0, points: 1 },
    { id: 'fast',    color: '#F97316', r: 8,  hp: 1, speedMul: 1.8, points: 1 },
    { id: 'big',     color: '#DC2626', r: 18, hp: 4, speedMul: 0.7, points: 2 },
    { id: 'tank',    color: '#7C3AED', r: 24, hp: 8, speedMul: 0.4, points: 3 },
    { id: 'swarm',   color: '#F59E0B', r: 6,  hp: 1, speedMul: 1.3, points: 1 },
    { id: 'giant',   color: '#991B1B', r: 32, hp: 15, speedMul: 0.25, points: 5 },
  ];

  // Boss configs — bosses are meant to be epic, long fights
  const BOSS_TYPES = [
    { name: 'Destroyer', color: '#FF0000', r: 45, hp: 2000, speedMul: 0.4,
      pattern: 'charge', desc: 'Chargeert op spelers!' },
    { name: 'Splitter', color: '#9333EA', r: 42, hp: 1500, speedMul: 0.35,
      pattern: 'split', desc: 'Splitst in stukken!' },
    { name: 'Shooter', color: '#DC2626', r: 42, hp: 2500, speedMul: 0.3,
      pattern: 'shoot', desc: 'Schiet terug!' },
  ];

  // ===================== POWERUP TYPES =====================
  const POWERUP_TYPES = [
    { id: 'rapidfire', label: '🔥 Rapid Fire', color: '#F97316', desc: 'Snelvuur!' },
    { id: 'speed',     label: '⚡ Snelheid',   color: '#3B82F6', desc: 'Super snel!' },
    { id: 'shield',    label: '🛡️ Schild',     color: '#22C55E', desc: 'Onkwetsbaar!' },
    { id: 'spread',    label: '💥 Spread Shot', color: '#EC4899', desc: '3-weg kogels!' },
    { id: 'piercing',  label: '🗡️ Doorborend', color: '#8B5CF6', desc: 'Kogels gaan door!' },
  ];

  // ===================== DIFFICULTY =====================
  const DIFFICULTIES = {
    easy:   { label: 'Makkelijk', spawnMul: 0.6, hpMul: 0.7, speedMul: 0.8, powerupRate: 1.5 },
    normal: { label: 'Normaal',   spawnMul: 1.0, hpMul: 1.0, speedMul: 1.0, powerupRate: 1.0 },
    hard:   { label: 'Moeilijk',  spawnMul: 1.4, hpMul: 1.5, speedMul: 1.2, powerupRate: 0.6 },
  };

  // ===================== STATE =====================
  let numPlayers = 0;
  let maxLives = 3;
  let friendlyFire = false;
  let difficulty = 'normal';
  let state = 'idle'; // idle | running | paused | waveBreather | done
  let resultTimeoutId = null;

  // Setup selections
  let selectedPlayers = 0;
  let selectedLives = 3;

  // Game state
  let players, bullets, enemies, particles, powerups, floatingTexts, trails;
  let totalKills, frameCount, waveNumber, waveEnemiesLeft, waveState, waveBreatherTimer;
  let boss, bossProjectiles;
  let shakeX, shakeY, shakeDuration;
  let slowMo, slowMoTimer;
  let comboCount, comboTimer, maxCombo;

  // ===================== SETUP LOGIC =====================
  document.querySelectorAll('.arena-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.arena-pick-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPlayers = parseInt(btn.dataset.players, 10);
      startBtn.disabled = false;
    });
  });
  document.querySelectorAll('.arena-life-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.arena-life-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedLives = parseInt(btn.dataset.lives, 10);
    });
  });
  document.querySelectorAll('.arena-diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.arena-diff-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      difficulty = btn.dataset.diff;
    });
  });
  const ffToggle = document.getElementById('arenaFriendlyFire');
  if (ffToggle) ffToggle.addEventListener('change', () => { friendlyFire = ffToggle.checked; });

  startBtn.addEventListener('click', () => {
    numPlayers = selectedPlayers;
    maxLives = selectedLives;
    setupEl.hidden = true;
    gameEl.hidden = false;
    initGame();
    startLoop();
  });
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      state = 'idle';
      if (resultTimeoutId) { clearTimeout(resultTimeoutId); resultTimeoutId = null; }
      setupEl.hidden = false;
      gameEl.hidden = true;
    });
  }

  // ===================== HIGH SCORES =====================
  function getHighScores() {
    try { return JSON.parse(localStorage.getItem('arena_highscores') || '[]'); } catch(e) { return []; }
  }
  function saveHighScore(score, wave, kills, players) {
    const scores = getHighScores();
    scores.push({ score, wave, kills, players, date: new Date().toLocaleDateString('nl-NL') });
    scores.sort((a, b) => b.score - a.score);
    localStorage.setItem('arena_highscores', JSON.stringify(scores.slice(0, 5)));
  }
  function renderHighScores() {
    const el = document.getElementById('arenaHighScores');
    if (!el) return;
    const scores = getHighScores();
    if (scores.length === 0) { el.innerHTML = '<span style="opacity:.5">Nog geen scores</span>'; return; }
    el.innerHTML = scores.map((s, i) =>
      '<div style="display:flex;justify-content:space-between;padding:2px 0">' +
      '<span>' + (i+1) + '. ' + s.score + ' pts</span>' +
      '<span style="opacity:.6">Wave ' + s.wave + ' · ' + s.kills + ' kills · ' + s.date + '</span></div>'
    ).join('');
  }
  renderHighScores();

  // ===================== INIT GAME =====================
  function initGame() {
    if (resultTimeoutId) { clearTimeout(resultTimeoutId); resultTimeoutId = null; }
    players = [];
    const startPositions = [
      { x: W * 0.25, y: H * 0.5 },
      { x: W * 0.75, y: H * 0.5 },
      { x: W * 0.25, y: H * 0.3 },
      { x: W * 0.75, y: H * 0.7 },
    ];
    for (let i = 0; i < numPlayers; i++) {
      const sp = startPositions[i];
      players.push({
        idx: i, x: sp.x, y: sp.y, dx: 0, dy: 1,
        lives: maxLives, alive: true, kills: 0, score: 0,
        cooldown: 0, invuln: 0,
        buffs: {},
        dashCooldown: 0, dashing: 0, dashDx: 0, dashDy: 0,
        trail: [],
      });
    }
    bullets = [];
    enemies = [];
    particles = [];
    powerups = [];
    floatingTexts = [];
    trails = [];
    bossProjectiles = [];
    boss = null;
    totalKills = 0;
    frameCount = 0;
    waveNumber = 0;
    waveEnemiesLeft = 0;
    waveState = 'breather'; // breather | spawning | fighting | boss
    waveBreatherTimer = 90; // short first breather
    shakeX = 0; shakeY = 0; shakeDuration = 0;
    slowMo = false; slowMoTimer = 0;
    comboCount = 0; comboTimer = 0; maxCombo = 0;

    buildHud();
    buildControls();
  }

  let loopRunning = false;
  function startLoop() {
    if (!loopRunning) { loopRunning = true; requestAnimationFrame(loop); }
  }

  // ===================== HUD =====================
  function buildHud() {
    let html = '';
    for (let i = 0; i < numPlayers; i++) {
      const cfg = PCFG[i];
      html += '<div class="arena-hud-player" id="aHud' + i + '" style="border-color:' + cfg.color + '">' +
        '<span style="color:' + cfg.color + ';font-weight:700">' + cfg.name + '</span>' +
        '<span class="arena-hud-hearts" id="aHearts' + i + '"></span>' +
        '<span style="opacity:.6">☠ <strong id="aKills' + i + '">0</strong></span>' +
        '<span id="aScore' + i + '" style="opacity:.6;font-size:.75rem"></span>' +
        '<span id="aBuffs' + i + '" style="font-size:.75rem"></span>' +
        '<span id="aDash' + i + '" style="font-size:.7rem"></span>' +
        '</div>';
    }
    hudEl.innerHTML = html;
    updateHud();
  }

  function updateHud() {
    for (let i = 0; i < numPlayers; i++) {
      const p = players[i];
      const hearts = document.getElementById('aHearts' + i);
      const kills = document.getElementById('aKills' + i);
      const wrap = document.getElementById('aHud' + i);
      const buffsEl = document.getElementById('aBuffs' + i);
      const scoreEl = document.getElementById('aScore' + i);
      const dashEl = document.getElementById('aDash' + i);
      if (hearts) hearts.textContent = '❤️'.repeat(Math.max(0, p.lives)) + '🖤'.repeat(Math.max(0, maxLives - p.lives));
      if (kills) kills.textContent = p.kills;
      if (wrap) wrap.classList.toggle('dead', !p.alive);
      if (scoreEl) scoreEl.textContent = ' ' + p.score + 'pts';
      if (dashEl) {
        if (p.dashCooldown > 0) {
          dashEl.innerHTML = '<span style="opacity:.4">💨 ' + Math.ceil(p.dashCooldown / 60) + 's</span>';
        } else {
          dashEl.innerHTML = '<span style="color:#22C55E">💨 Klaar</span>';
        }
      }
      if (buffsEl) {
        let bt = '';
        for (const key in p.buffs) {
          const pu = POWERUP_TYPES.find(t => t.id === key);
          if (pu && p.buffs[key] > 0) {
            const secs = Math.ceil(p.buffs[key] / 60);
            bt += '<span style="color:' + pu.color + '" title="' + pu.label + '">' + pu.label.split(' ')[0] + secs + 's</span> ';
          }
        }
        buffsEl.innerHTML = bt;
      }
    }
  }

  function buildControls() {
    let html = '';
    for (let i = 0; i < numPlayers; i++) {
      const c = PCFG[i];
      html += '<div style="color:' + c.color + ';font-weight:600;display:inline-block;margin:0 .6rem">' +
        c.name + ': ' +
        '<kbd>' + c.upL + '</kbd><kbd>' + c.leftL + '</kbd><kbd>' + c.downL + '</kbd><kbd>' + c.rightL + '</kbd> bewegen · ' +
        '<kbd>' + c.shootL + '</kbd> schieten · ' +
        '<kbd>' + c.dashL + '</kbd> dash</div>';
    }
    html += '<div style="opacity:.5;margin-top:.3rem"><kbd>Esc</kbd> pauze</div>';
    controlsEl.innerHTML = html;
  }

  // ===================== HELPERS =====================
  function diff() { return DIFFICULTIES[difficulty]; }
  function hasBuff(p, id) { return p.buffs[id] && p.buffs[id] > 0; }
  function playerSpeed(p) { return PLAYER_SPEED * (hasBuff(p, 'speed') ? 1.8 : 1); }
  function playerCooldown(p) { return hasBuff(p, 'rapidfire') ? 3 : BULLET_COOLDOWN; }

  function addShake(amount) { shakeDuration = Math.max(shakeDuration, amount); }
  function addFloatingText(x, y, text, color, size) {
    floatingTexts.push({ x, y, text, color, life: 1, vy: -1.2, size: size || 11 });
  }
  function spawnExplosion(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1 + Math.random() * 3;
      particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, color });
    }
  }

  // ===================== THEME =====================
  function themeColors() {
    const dark = document.documentElement.getAttribute('data-theme') !== 'light';
    return {
      bg: dark ? '#0f172a' : '#f1f5f9',
      grid: dark ? 'rgba(255,255,255,.03)' : 'rgba(0,0,0,.04)',
      wall: dark ? '#475569' : '#94a3b8',
      text: dark ? '#e2e8f0' : '#1e293b',
      enemyEye: dark ? '#0f172a' : '#fff',
      bullet: '#FBBF24',
    };
  }

  // ===================== WAVE SYSTEM =====================
  function getWaveEnemyCount(wave) {
    const base = 5 + wave * 3 + Math.floor(wave * wave * 0.3);
    return Math.floor(base * numPlayers * diff().spawnMul);
  }

  function startNextWave() {
    waveNumber++;
    sfxWave();

    // Boss every 5 waves
    if (waveNumber % 5 === 0) {
      waveState = 'boss';
      spawnBoss();
      addFloatingText(W / 2, H / 2 - 40, '⚠ BOSS WAVE ' + waveNumber + ' ⚠', '#FF0000', 18);
    } else {
      waveState = 'spawning';
      waveEnemiesLeft = getWaveEnemyCount(waveNumber);
      addFloatingText(W / 2, H / 2, 'Wave ' + waveNumber, '#FBBF24', 20);
    }
  }

  function spawnBoss() {
    const bt = BOSS_TYPES[(Math.floor(waveNumber / 5) - 1) % BOSS_TYPES.length];
    const hpMul = 1 + (waveNumber / 5 - 1) * 0.5;
    const hp = Math.floor(bt.hp * numPlayers * hpMul * diff().hpMul);
    boss = {
      x: W / 2, y: -60,
      r: bt.r, hp, maxHp: hp,
      speed: 1.0 * bt.speedMul * diff().speedMul,
      vx: 0, vy: 0,
      color: bt.color, name: bt.name,
      pattern: bt.pattern, desc: bt.desc,
      timer: 0, chargeTarget: null, charging: false,
      // Phase system: normal -> enraged (50% hp) -> berserk (25% hp)
      phase: 'normal',
      enrageTriggered: false,
      berserkTriggered: false,
      // Ring attack cooldown
      ringTimer: 0,
      // Stomp/shockwave cooldown
      stompTimer: 0,
    };
    sfxBoss();
    addShake(15);
    addFloatingText(W / 2, H / 2, '💀 ' + bt.name + ': ' + bt.desc, bt.color, 14);
  }

  function updateBossPhase() {
    if (!boss) return;
    const hpRatio = boss.hp / boss.maxHp;
    if (hpRatio <= 0.25 && !boss.berserkTriggered) {
      boss.berserkTriggered = true;
      boss.phase = 'berserk';
      boss.speed *= 1.6;
      boss.r = Math.floor(boss.r * 0.9); // shrinks slightly, harder to hit
      addShake(25);
      addFloatingText(boss.x, boss.y - boss.r - 20, '🔥 BERSERK MODE! 🔥', '#FF0000', 20);
      sfxBoss();
      // Spawn a ring of bullets on berserk trigger
      spawnBossRing(16, 4.5);
    } else if (hpRatio <= 0.5 && !boss.enrageTriggered) {
      boss.enrageTriggered = true;
      boss.phase = 'enraged';
      boss.speed *= 1.3;
      addShake(18);
      addFloatingText(boss.x, boss.y - boss.r - 20, '⚠ ENRAGED! ⚠', '#F97316', 18);
      sfxBoss();
      // Spawn a ring of bullets on enrage trigger
      spawnBossRing(12, 3.5);
    }
  }

  function spawnBossRing(count, speed) {
    if (!boss) return;
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 / count) * i;
      bossProjectiles.push({
        x: boss.x, y: boss.y,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        r: 5, enemy: true,
      });
    }
    sfxHit();
  }

  // ===================== ENEMY SPAWN =====================
  function spawnEdge() {
    const side = Math.floor(Math.random() * 4);
    const margin = 30;
    if (side === 0) return { x: -margin, y: Math.random() * H };
    if (side === 1) return { x: W + margin, y: Math.random() * H };
    if (side === 2) return { x: Math.random() * W, y: -margin };
    return { x: Math.random() * W, y: H + margin };
  }

  function spawnEnemy() {
    const pos = spawnEdge();
    const progress = Math.min(waveNumber / 20, 1);
    const roll = Math.random();
    let type;
    if (roll < 0.04 && progress > 0.5) type = ENEMY_TYPES[5];
    else if (roll < 0.10 && progress > 0.3) type = ENEMY_TYPES[3];
    else if (roll < 0.22 && progress > 0.15) type = ENEMY_TYPES[2];
    else if (roll < 0.38) type = ENEMY_TYPES[1];
    else if (roll < 0.52 && progress > 0.05) type = ENEMY_TYPES[4];
    else type = ENEMY_TYPES[0];

    const d = diff();
    const waveMul = 1 + waveNumber * 0.04;
    const spd = 1.2 * type.speedMul * waveMul * d.speedMul * (0.85 + Math.random() * 0.3);
    const hpScale = 1 + Math.floor(waveNumber / 8);
    const hp = Math.max(1, Math.floor(type.hp * hpScale * d.hpMul));

    enemies.push({
      x: pos.x, y: pos.y, r: type.r, hp, maxHp: hp,
      speed: spd, vx: 0, vy: 0,
      color: type.color, typeId: type.id, points: type.points,
    });
  }

  // ===================== POWERUP SPAWN =====================
  function trySpawnPowerup() {
    if (powerups.length >= 3) return;
    if (Math.random() > 0.002 * diff().powerupRate) return;
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    const x = 60 + Math.random() * (W - 120);
    const y = 60 + Math.random() * (H - 120);
    powerups.push({
      x, y, typeId: type.id, color: type.color,
      icon: type.label.split(' ')[0], label: type.label, desc: type.desc,
      ttl: 600,
    });
  }

  // ===================== DRAWING =====================
  function drawBg(c) {
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = c.grid;
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.strokeStyle = c.wall; ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);
  }

  function drawTrails() {
    for (const p of players) {
      if (!p.alive) continue;
      const t = p.trail;
      for (let i = 0; i < t.length; i++) {
        const alpha = (i / t.length) * 0.2;
        ctx.fillStyle = PCFG[p.idx].color;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(t[i].x, t[i].y, PLAYER_R * 0.5 * (i / t.length), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayers(c) {
    for (const p of players) {
      if (!p.alive) continue;
      if (p.invuln > 0 && Math.floor(p.invuln / 4) % 2 === 0 && p.dashing <= 0) continue;
      const cfg = PCFG[p.idx];

      // Dash visual
      if (p.dashing > 0) {
        ctx.strokeStyle = cfg.color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, PLAYER_R + 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // Shield glow
      if (hasBuff(p, 'shield')) {
        ctx.strokeStyle = '#22C55E'; ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4 + Math.sin(frameCount * 0.15) * 0.2;
        ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R + 5, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      // Speed trail from buff
      if (hasBuff(p, 'speed')) {
        ctx.fillStyle = cfg.color; ctx.globalAlpha = 0.15;
        ctx.beginPath(); ctx.arc(p.x - p.dx * 6, p.y - p.dy * 6, PLAYER_R * 0.7, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      }
      // Body
      ctx.fillStyle = cfg.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_R, 0, Math.PI * 2); ctx.fill();
      // Direction indicator
      ctx.fillStyle = 'rgba(255,255,255,.6)';
      const angle = Math.atan2(p.dy, p.dx);
      const tx = p.x + Math.cos(angle) * (PLAYER_R + 4);
      const ty = p.y + Math.sin(angle) * (PLAYER_R + 4);
      ctx.beginPath(); ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(angle + 2.5) * 5, ty + Math.sin(angle + 2.5) * 5);
      ctx.lineTo(tx + Math.cos(angle - 2.5) * 5, ty + Math.sin(angle - 2.5) * 5);
      ctx.closePath(); ctx.fill();
      // Name
      ctx.fillStyle = cfg.color;
      ctx.font = 'bold 9px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(cfg.name, p.x, p.y - PLAYER_R - 4);
    }
  }

  function drawBullets(c) {
    for (const b of bullets) {
      ctx.fillStyle = b.piercing ? '#8B5CF6' : (b.enemy ? '#FF4444' : c.bullet);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.piercing ? 4 : (b.enemy ? 4 : BULLET_R), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawEnemies(c) {
    for (const e of enemies) {
      if (e.maxHp > 1) {
        const barW = e.r * 2, barH = 3, barX = e.x - e.r, barY = e.y - e.r - 6;
        ctx.fillStyle = 'rgba(0,0,0,.3)';
        ctx.fillRect(barX, barY, barW, barH);
        ctx.fillStyle = e.hp > e.maxHp * 0.5 ? '#22C55E' : (e.hp > e.maxHp * 0.25 ? '#F59E0B' : '#EF4444');
        ctx.fillRect(barX, barY, barW * (e.hp / e.maxHp), barH);
      }
      ctx.fillStyle = e.color;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2); ctx.fill();
      if (e.maxHp >= 8) {
        ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * 0.6, 0, Math.PI * 2); ctx.stroke();
      }
      const evx = e.vx || 0, evy = e.vy || 0;
      const eyeOff = Math.min(e.r * 0.2, 3);
      const enx = evx === 0 && evy === 0 ? 0 : evx / Math.hypot(evx, evy);
      const eny = evx === 0 && evy === 0 ? 0 : evy / Math.hypot(evx, evy);
      const eyeR = Math.max(1.5, e.r * 0.15);
      ctx.fillStyle = c.enemyEye;
      ctx.beginPath();
      ctx.arc(e.x + enx * eyeOff - e.r * 0.2, e.y + eny * eyeOff - 1, eyeR, 0, Math.PI * 2);
      ctx.arc(e.x + enx * eyeOff + e.r * 0.2, e.y + eny * eyeOff - 1, eyeR, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawBoss(c) {
    if (!boss) return;
    const b = boss;
    const isEnraged = b.phase === 'enraged' || b.phase === 'berserk';
    const isBerserk = b.phase === 'berserk';

    // HP bar at top
    const barW = W * 0.6, barH = 10, barX = (W - barW) / 2, barY = 24;
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
    const hpRatio = b.hp / b.maxHp;
    const barColor = isBerserk ? '#FF0000' : (isEnraged ? '#F97316' : (hpRatio > 0.5 ? '#EF4444' : (hpRatio > 0.25 ? '#F59E0B' : '#DC2626')));
    ctx.fillStyle = barColor;
    ctx.fillRect(barX, barY, barW * hpRatio, barH);
    // Phase markers on HP bar
    ctx.fillStyle = 'rgba(255,255,255,.4)';
    ctx.fillRect(barX + barW * 0.5, barY, 1, barH); // 50% marker
    ctx.fillRect(barX + barW * 0.25, barY, 1, barH); // 25% marker
    ctx.fillStyle = c.text; ctx.font = 'bold 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const phaseLabel = isBerserk ? ' 🔥 BERSERK' : (isEnraged ? ' ⚠ ENRAGED' : '');
    ctx.fillText('💀 ' + b.name + phaseLabel + ' — ' + b.hp + '/' + b.maxHp, W / 2, barY - 4);

    // Berserk fire ring
    if (isBerserk) {
      ctx.strokeStyle = '#FF0000'; ctx.lineWidth = 3;
      ctx.globalAlpha = 0.4 + Math.sin(frameCount * 0.2) * 0.3;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 18 + Math.sin(frameCount * 0.15) * 4, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Enrage glow
    if (isEnraged) {
      ctx.fillStyle = isBerserk ? '#FF000044' : '#F9731644';
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 1.6, 0, Math.PI * 2); ctx.fill();
    }

    // Body
    const pulse = 1 + Math.sin(frameCount * (isBerserk ? 0.15 : 0.08)) * (isBerserk ? 0.1 : 0.05);
    ctx.fillStyle = b.color; ctx.globalAlpha = 0.2;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 1.3 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    // Inner ring
    ctx.strokeStyle = isEnraged ? 'rgba(255,100,0,.5)' : 'rgba(255,255,255,.3)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.6, 0, Math.PI * 2); ctx.stroke();
    // Skull icon — bigger for berserk
    ctx.fillStyle = '#fff'; ctx.font = 'bold ' + (isBerserk ? '26' : '20') + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('💀', b.x, b.y);
    ctx.textBaseline = 'alphabetic';
    // Charging indicator
    if (b.charging) {
      ctx.strokeStyle = '#FF0000'; ctx.lineWidth = 3; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.arc(b.x, b.y, b.r + 12, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawPowerups() {
    for (const pu of powerups) {
      const pulse = 1 + Math.sin(frameCount * 0.1 + pu.x) * 0.15;
      ctx.fillStyle = pu.color; ctx.globalAlpha = 0.2;
      ctx.beginPath(); ctx.arc(pu.x, pu.y, POWERUP_R * 1.8 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = pu.color;
      ctx.beginPath(); ctx.arc(pu.x, pu.y, POWERUP_R * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pu.icon, pu.x, pu.y + 1); ctx.textBaseline = 'alphabetic';
    }
  }

  function drawParticles() {
    for (const pt of particles) {
      ctx.globalAlpha = pt.life; ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - 1.5, pt.y - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  function drawFloatingTexts() {
    for (const ft of floatingTexts) {
      ctx.globalAlpha = ft.life; ctx.fillStyle = ft.color;
      ctx.font = 'bold ' + (ft.size || 11) + 'px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(ft.text, ft.x, ft.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawEdgeIndicators(c) {
    // Red arrows pointing toward off-screen enemies
    const margin = 14;
    for (const e of enemies) {
      if (e.x >= 0 && e.x <= W && e.y >= 0 && e.y <= H) continue;
      const cx = Math.max(margin, Math.min(W - margin, e.x));
      const cy = Math.max(margin, Math.min(H - margin, e.y));
      const angle = Math.atan2(e.y - H / 2, e.x - W / 2);
      ctx.fillStyle = e.color || '#EF4444';
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * 8, cy + Math.sin(angle) * 8);
      ctx.lineTo(cx + Math.cos(angle + 2.4) * 5, cy + Math.sin(angle + 2.4) * 5);
      ctx.lineTo(cx + Math.cos(angle - 2.4) * 5, cy + Math.sin(angle - 2.4) * 5);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
    }
    // Boss indicator
    if (boss && (boss.x < 0 || boss.x > W || boss.y < 0 || boss.y > H)) {
      const cx = Math.max(margin, Math.min(W - margin, boss.x));
      const cy = Math.max(margin, Math.min(H - margin, boss.y));
      ctx.fillStyle = '#FF0000'; ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('💀', cx, cy);
    }
  }

  function drawCombo(c) {
    if (comboCount >= 2) {
      ctx.fillStyle = comboCount >= 10 ? '#FF0000' : (comboCount >= 5 ? '#F97316' : '#FBBF24');
      ctx.globalAlpha = Math.min(1, comboTimer / 30);
      const sz = Math.min(24, 14 + comboCount * 0.5);
      ctx.font = 'bold ' + sz + 'px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(comboCount + 'x COMBO!', W / 2, H - 20);
      ctx.globalAlpha = 1;
    }
  }

  function drawHudOverlay(c) {
    ctx.fillStyle = c.text; ctx.globalAlpha = 0.35;
    ctx.font = 'bold 12px Inter, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Wave ' + waveNumber + ' · Kills: ' + totalKills, 8, 16);
    const t = Math.floor(frameCount / 60);
    ctx.textAlign = 'right';
    ctx.fillText(String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'), W - 8, 16);
    ctx.globalAlpha = 1;

    // Pause indicator
    if (state === 'paused') {
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 28px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⏸ PAUZE', W / 2, H / 2 - 10);
      ctx.font = '14px Inter, system-ui, sans-serif'; ctx.globalAlpha = 0.6;
      ctx.fillText('Druk op Esc om verder te gaan', W / 2, H / 2 + 20);
      ctx.globalAlpha = 1;
    }

    // Wave breather
    if (state === 'running' && waveState === 'breather') {
      ctx.fillStyle = '#FBBF24'; ctx.globalAlpha = 0.8;
      ctx.font = 'bold 20px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      const nextW = waveNumber + 1;
      const isBoss = nextW % 5 === 0;
      ctx.fillText(isBoss ? '⚠ BOSS WAVE ' + nextW + ' INCOMING...' : 'Wave ' + nextW + ' begint over ' + Math.ceil(waveBreatherTimer / 60) + 's', W / 2, H / 2);
      ctx.globalAlpha = 1;
    }
  }

  // ===================== BOSS UPDATE =====================
  function updateBoss() {
    if (!boss) return;
    boss.timer++;
    boss.ringTimer++;
    boss.stompTimer++;
    updateBossPhase();
    const alivePlayers = players.filter(p => p.alive);
    if (alivePlayers.length === 0) return;

    // Find nearest player
    let nearest = null, bestDist = Infinity;
    for (const p of alivePlayers) {
      const d = Math.hypot(p.x - boss.x, p.y - boss.y);
      if (d < bestDist) { bestDist = d; nearest = p; }
    }

    const phase = boss.phase;
    const isEnraged = phase === 'enraged' || phase === 'berserk';
    const isBerserk = phase === 'berserk';

    // ---- Periodic ring attack for ALL boss types when enraged/berserk ----
    const ringInterval = isBerserk ? 90 : 150;
    if (isEnraged && boss.ringTimer % ringInterval === 0) {
      const ringCount = isBerserk ? 20 : 14;
      const ringSpeed = isBerserk ? 4.0 : 3.0;
      spawnBossRing(ringCount, ringSpeed);
      addFloatingText(boss.x, boss.y - boss.r, '💫', '#FF6600', 14);
    }

    // ---- CHARGE PATTERN (Destroyer) ----
    if (boss.pattern === 'charge') {
      const chargeInterval = isBerserk ? 50 : (isEnraged ? 80 : 120);
      const chargeSpeed = isBerserk ? 10 : (isEnraged ? 7.5 : 5.5);

      if (boss.timer % chargeInterval === 0) {
        boss.charging = true;
        // In berserk, target a random alive player for unpredictability
        const target = isBerserk ? alivePlayers[Math.floor(Math.random() * alivePlayers.length)] : nearest;
        boss.chargeTarget = { x: target.x, y: target.y };
        addFloatingText(boss.x, boss.y - boss.r - 10, '💥 CHARGE!', '#FF0000', 14);
        sfxHit();
      }
      if (boss.charging) {
        const ct = boss.chargeTarget;
        const angle = Math.atan2(ct.y - boss.y, ct.x - boss.x);
        boss.vx = Math.cos(angle) * chargeSpeed;
        boss.vy = Math.sin(angle) * chargeSpeed;
        if (Math.hypot(boss.x - ct.x, boss.y - ct.y) < 25) {
          boss.charging = false;
          // Shockwave on charge arrival
          if (isEnraged) {
            addShake(10);
            spawnBossRing(8, 2.5);
            spawnExplosion(boss.x, boss.y, '#FF4400', 12);
          }
        }
      } else {
        const angle = Math.atan2(nearest.y - boss.y, nearest.x - boss.x);
        boss.vx = Math.cos(angle) * boss.speed;
        boss.vy = Math.sin(angle) * boss.speed;
      }
      // Destroyer also fires a few aimed bullets when enraged
      if (isEnraged && boss.timer % (isBerserk ? 30 : 50) === 0) {
        const a = Math.atan2(nearest.y - boss.y, nearest.x - boss.x);
        for (let s = -1; s <= 1; s++) {
          bossProjectiles.push({
            x: boss.x, y: boss.y,
            vx: Math.cos(a + s * 0.2) * 3.5, vy: Math.sin(a + s * 0.2) * 3.5,
            r: 5, enemy: true,
          });
        }
        sfxHit();
      }

    // ---- SHOOT PATTERN (Shooter) ----
    } else if (boss.pattern === 'shoot') {
      const angle = Math.atan2(nearest.y - boss.y, nearest.x - boss.x);
      boss.vx = Math.cos(angle) * boss.speed;
      boss.vy = Math.sin(angle) * boss.speed;

      // Aimed shots at all players
      const aimInterval = isBerserk ? 12 : (isEnraged ? 20 : 30);
      if (boss.timer % aimInterval === 0) {
        const bulletSpeed = isBerserk ? 4.5 : (isEnraged ? 4.0 : 3.5);
        for (const p of alivePlayers) {
          const a = Math.atan2(p.y - boss.y, p.x - boss.x);
          // Fire a cluster of 3 at each player
          const spreadAmt = isBerserk ? 0.15 : (isEnraged ? 0.12 : 0.08);
          for (let s = -1; s <= 1; s++) {
            bossProjectiles.push({
              x: boss.x, y: boss.y,
              vx: Math.cos(a + s * spreadAmt) * bulletSpeed,
              vy: Math.sin(a + s * spreadAmt) * bulletSpeed,
              r: 5, enemy: true,
            });
          }
        }
        sfxHit();
      }
      // Spiral attack
      const spiralInterval = isBerserk ? 4 : (isEnraged ? 6 : 10);
      if (boss.timer % spiralInterval === 0) {
        const spiralAngle = boss.timer * 0.15;
        const spiralSpeed = 2.5;
        bossProjectiles.push({
          x: boss.x, y: boss.y,
          vx: Math.cos(spiralAngle) * spiralSpeed,
          vy: Math.sin(spiralAngle) * spiralSpeed,
          r: 4, enemy: true,
        });
      }

    // ---- SPLIT PATTERN (Splitter) ----
    } else if (boss.pattern === 'split') {
      const angle = Math.atan2(nearest.y - boss.y, nearest.x - boss.x);
      boss.vx = Math.cos(angle) * boss.speed;
      boss.vy = Math.sin(angle) * boss.speed;

      const splitInterval = isBerserk ? 50 : (isEnraged ? 70 : 100);
      const minionCount = isBerserk ? 8 : (isEnraged ? 5 : 3);
      const minionHp = isBerserk ? 5 : (isEnraged ? 4 : 3);

      if (boss.timer % splitInterval === 0) {
        for (let i = 0; i < minionCount; i++) {
          const a = (Math.PI * 2 / minionCount) * i;
          const mSpd = 1.5 + (isEnraged ? 0.5 : 0) + (isBerserk ? 0.5 : 0);
          enemies.push({
            x: boss.x + Math.cos(a) * 45, y: boss.y + Math.sin(a) * 45,
            r: isBerserk ? 10 : 8, hp: minionHp, maxHp: minionHp,
            speed: mSpd, vx: 0, vy: 0,
            color: '#C084FC', typeId: 'minion', points: 1,
          });
        }
        addFloatingText(boss.x, boss.y - boss.r, 'Split!', '#9333EA', 12);
      }
      // Splitter also fires projectiles when enraged
      if (isEnraged && boss.timer % (isBerserk ? 25 : 40) === 0) {
        for (const p of alivePlayers) {
          const a = Math.atan2(p.y - boss.y, p.x - boss.x);
          bossProjectiles.push({
            x: boss.x, y: boss.y,
            vx: Math.cos(a) * 3, vy: Math.sin(a) * 3,
            r: 5, enemy: true,
          });
        }
        sfxHit();
      }
    }

    boss.x += boss.vx; boss.y += boss.vy;
    boss.x = Math.max(boss.r, Math.min(W - boss.r, boss.x));
    boss.y = Math.max(boss.r, Math.min(H - boss.r, boss.y));

    // Boss-player collisions
    for (const p of alivePlayers) {
      if (p.invuln > 0) continue;
      if (Math.hypot(p.x - boss.x, p.y - boss.y) < PLAYER_R + boss.r) {
        if (hasBuff(p, 'shield')) {
          p.invuln = 15;
          addFloatingText(p.x, p.y - 20, 'Geblokt!', '#22C55E');
        } else {
          p.lives--;
          p.invuln = INVULN_FRAMES;
          spawnExplosion(p.x, p.y, PCFG[p.idx].color, 8);
          sfxDamage(); addShake(8);
          if (p.lives <= 0) {
            p.alive = false;
            deathExplosion(p);
          }
        }
      }
    }

    // Bullet-boss collisions
    for (let bi = bullets.length - 1; bi >= 0; bi--) {
      const b = bullets[bi];
      if (b.enemy) continue;
      if (Math.hypot(b.x - boss.x, b.y - boss.y) < BULLET_R + boss.r) {
        boss.hp--;
        spawnExplosion(b.x, b.y, '#FBBF24', 3);
        sfxHit();
        if (!b.piercing) bullets.splice(bi, 1);
        const owner = players[b.owner];
        if (owner) { owner.kills++; owner.score += 1; }
        totalKills++;
        registerComboHit();
        if (boss.hp <= 0) {
          // Boss defeated!
          spawnExplosion(boss.x, boss.y, boss.color, 40);
          addFloatingText(boss.x, boss.y, '💀 VERSLAGEN! +50pts', '#FBBF24', 18);
          addShake(20);
          sfxKill(); sfxKill();
          // Award bonus score
          for (const p of players) { if (p.alive) p.score += 50; }
          boss = null;
          bossProjectiles = [];
          waveState = 'breather';
          waveBreatherTimer = WAVE_BREATHER;
          triggerSlowMo(20);
          break;
        }
      }
    }
  }

  // ===================== DEATH EXPLOSION =====================
  function deathExplosion(p) {
    spawnExplosion(p.x, p.y, PCFG[p.idx].color, 30);
    sfxDeath(); addShake(12);
    // Revenge: damage nearby enemies
    for (let ei = enemies.length - 1; ei >= 0; ei--) {
      const e = enemies[ei];
      if (Math.hypot(e.x - p.x, e.y - p.y) < 80) {
        e.hp -= 3;
        spawnExplosion(e.x, e.y, PCFG[p.idx].color, 5);
        if (e.hp <= 0) {
          enemies.splice(ei, 1);
          totalKills++;
          p.kills++;
          p.score += (e.points || 1);
        }
      }
    }
    // Damage boss if nearby
    if (boss && Math.hypot(boss.x - p.x, boss.y - p.y) < 100) {
      boss.hp -= 5;
      spawnExplosion(boss.x, boss.y, PCFG[p.idx].color, 8);
    }
    addFloatingText(p.x, p.y - 20, '💥 Wraak-explosie!', PCFG[p.idx].color, 12);
  }

  // ===================== SLOW-MO =====================
  function triggerSlowMo(frames) { slowMo = true; slowMoTimer = frames; }

  // ===================== COMBO =====================
  function registerComboHit() {
    comboCount++;
    comboTimer = COMBO_WINDOW;
    if (comboCount > maxCombo) maxCombo = comboCount;
    if (comboCount >= 5 && comboCount % 5 === 0) {
      sfxCombo();
      addFloatingText(W / 2, H / 2 + 30, comboCount + 'x COMBO!', '#FBBF24', 16);
    }
  }

  // ===================== UPDATE =====================
  function update() {
    if (state === 'paused' || state === 'done' || state === 'idle') return;

    // Slow-mo: skip every other frame
    if (slowMo) {
      slowMoTimer--;
      if (slowMoTimer <= 0) slowMo = false;
      if (frameCount % 2 !== 0) { frameCount++; return; }
    }

    frameCount++;

    // Combo timer
    if (comboTimer > 0) {
      comboTimer--;
      if (comboTimer <= 0) comboCount = 0;
    }

    // Wave system
    if (waveState === 'breather') {
      waveBreatherTimer--;
      if (waveBreatherTimer <= 0) startNextWave();
    } else if (waveState === 'spawning') {
      // Spawn enemies for this wave
      const spawnRate = Math.max(8, 30 - waveNumber * 2);
      if (frameCount % spawnRate === 0 && waveEnemiesLeft > 0) {
        const batch = Math.min(waveEnemiesLeft, 1 + Math.floor(waveNumber / 4));
        for (let i = 0; i < batch; i++) { spawnEnemy(); waveEnemiesLeft--; }
      }
      if (waveEnemiesLeft <= 0) waveState = 'fighting';
    } else if (waveState === 'fighting') {
      if (enemies.length === 0) {
        // Wave cleared!
        waveState = 'breather';
        waveBreatherTimer = WAVE_BREATHER;
        addFloatingText(W / 2, H / 2, '✅ Wave ' + waveNumber + ' gehaald!', '#22C55E', 18);
        sfxWave();
        // Bonus score for clearing wave
        for (const p of players) { if (p.alive) p.score += waveNumber * 5; }
      }
    } else if (waveState === 'boss') {
      updateBoss();
      // Also clear normal enemies for boss wave
      if (boss === null && enemies.length === 0) {
        // Boss defeated and minions cleared
        // Already handled in updateBoss
      }
    }

    trySpawnPowerup();

    // Screen shake decay
    if (shakeDuration > 0) {
      shakeDuration--;
      shakeX = (Math.random() - 0.5) * shakeDuration * 0.5;
      shakeY = (Math.random() - 0.5) * shakeDuration * 0.5;
    } else {
      shakeX = 0; shakeY = 0;
    }

    const alivePlayers = players.filter(p => p.alive);

    // Update players
    for (const p of players) {
      if (!p.alive) continue;
      if (p.invuln > 0) p.invuln--;
      if (p.cooldown > 0) p.cooldown--;
      if (p.dashCooldown > 0) p.dashCooldown--;

      // Tick down buffs
      for (const key in p.buffs) {
        if (p.buffs[key] > 0) p.buffs[key]--;
        if (p.buffs[key] <= 0) delete p.buffs[key];
      }

      const cfg = PCFG[p.idx];

      // Dashing
      if (p.dashing > 0) {
        p.dashing--;
        p.x += p.dashDx * DASH_SPEED;
        p.y += p.dashDy * DASH_SPEED;
        p.x = Math.max(PLAYER_R, Math.min(W - PLAYER_R, p.x));
        p.y = Math.max(PLAYER_R, Math.min(H - PLAYER_R, p.y));
        // Trail during dash
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 8) p.trail.shift();
        continue; // skip normal movement during dash
      }

      let mx = 0, my = 0;
      if (keysDown.has(cfg.up)) my -= 1;
      if (keysDown.has(cfg.down)) my += 1;
      if (keysDown.has(cfg.left)) mx -= 1;
      if (keysDown.has(cfg.right)) mx += 1;
      if (mx !== 0 && my !== 0) { mx *= 0.707; my *= 0.707; }

      const spd = playerSpeed(p);
      p.x += mx * spd;
      p.y += my * spd;
      if (mx !== 0 || my !== 0) { p.dx = mx; p.dy = my; }
      p.x = Math.max(PLAYER_R, Math.min(W - PLAYER_R, p.x));
      p.y = Math.max(PLAYER_R, Math.min(H - PLAYER_R, p.y));

      // Player trail (for afterimage)
      if (mx !== 0 || my !== 0) {
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 6) p.trail.shift();
      } else if (p.trail.length > 0) {
        p.trail.shift();
      }

      // Shooting — 3 parallel lines
      if (keysDown.has(cfg.shoot) && p.cooldown <= 0) {
        const angle = Math.atan2(p.dy, p.dx);
        const piercing = hasBuff(p, 'piercing');
        const PARALLEL_GAP = 6;
        const angles = hasBuff(p, 'spread') ? [angle - 0.3, angle, angle + 0.3] : [angle];
        for (const a of angles) {
          const pX = -Math.sin(a), pY = Math.cos(a);
          for (const offset of [-PARALLEL_GAP, 0, PARALLEL_GAP]) {
            const bx = p.x + Math.cos(a) * (PLAYER_R + 4) + pX * offset;
            const by = p.y + Math.sin(a) * (PLAYER_R + 4) + pY * offset;
            bullets.push({ x: bx, y: by, vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED, owner: p.idx, piercing });
          }
        }
        p.cooldown = playerCooldown(p);
        sfxShoot();
      }

      // Dash
      if (keysDown.has(cfg.dash) && p.dashCooldown <= 0 && p.dashing <= 0) {
        p.dashing = DASH_DURATION;
        p.dashCooldown = DASH_COOLDOWN;
        p.dashDx = p.dx; p.dashDy = p.dy;
        p.invuln = Math.max(p.invuln, DASH_DURATION); // invulnerable during dash
        sfxDash();
      }

      // Powerup pickup
      for (let pi = powerups.length - 1; pi >= 0; pi--) {
        const pu = powerups[pi];
        if (Math.hypot(p.x - pu.x, p.y - pu.y) < PLAYER_R + POWERUP_R) {
          const dur = POWERUP_DURATION_MIN + Math.floor(Math.random() * (POWERUP_DURATION_MAX - POWERUP_DURATION_MIN));
          p.buffs[pu.typeId] = dur;
          addFloatingText(pu.x, pu.y - 10, pu.desc, pu.color);
          spawnExplosion(pu.x, pu.y, pu.color, 8);
          powerups.splice(pi, 1);
          sfxPickup();
        }
      }
    }

    // Update powerup TTL
    for (let pi = powerups.length - 1; pi >= 0; pi--) {
      powerups[pi].ttl--;
      if (powerups[pi].ttl <= 0) powerups.splice(pi, 1);
    }

    // Update bullets (player + boss projectiles merged)
    for (const b of bullets) { b.x += b.vx; b.y += b.vy; }
    for (const b of bossProjectiles) { b.x += b.vx; b.y += b.vy; }
    bullets = bullets.filter(b => b.x > -10 && b.x < W + 10 && b.y > -10 && b.y < H + 10);
    bossProjectiles = bossProjectiles.filter(b => b.x > -10 && b.x < W + 10 && b.y > -10 && b.y < H + 10);

    // Boss projectile-player collisions
    for (let bi = bossProjectiles.length - 1; bi >= 0; bi--) {
      const b = bossProjectiles[bi];
      for (const p of players) {
        if (!p.alive || p.invuln > 0) continue;
        if (Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_R + b.r) {
          if (hasBuff(p, 'shield')) {
            p.invuln = 15;
            addFloatingText(p.x, p.y - 20, 'Geblokt!', '#22C55E');
          } else {
            p.lives--;
            p.invuln = INVULN_FRAMES;
            spawnExplosion(p.x, p.y, PCFG[p.idx].color, 8);
            sfxDamage(); addShake(6);
            if (p.lives <= 0) { p.alive = false; deathExplosion(p); }
          }
          bossProjectiles.splice(bi, 1);
          break;
        }
      }
    }

    // Update enemies
    for (const e of enemies) {
      let nearest = null, bestDist = Infinity;
      for (const p of alivePlayers) {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d < bestDist) { bestDist = d; nearest = p; }
      }
      if (nearest) {
        const angle = Math.atan2(nearest.y - e.y, nearest.x - e.x);
        e.vx = Math.cos(angle) * e.speed;
        e.vy = Math.sin(angle) * e.speed;
      }
      e.x += e.vx; e.y += e.vy;
    }

    // Bullet-enemy collisions
    const deadBullets = new Set();
    const deadEnemies = new Set();
    for (let bi = 0; bi < bullets.length; bi++) {
      if (deadBullets.has(bi)) continue;
      const b = bullets[bi];
      if (b.enemy) continue; // boss projectiles don't hit enemies
      for (let ei = 0; ei < enemies.length; ei++) {
        if (deadEnemies.has(ei)) continue;
        const e = enemies[ei];
        if (Math.hypot(b.x - e.x, b.y - e.y) < BULLET_R + e.r) {
          if (!b.piercing) deadBullets.add(bi);
          e.hp--;
          spawnExplosion(b.x, b.y, '#FBBF24', 3);
          sfxHit();
          if (e.hp <= 0) {
            deadEnemies.add(ei);
            spawnExplosion(e.x, e.y, e.color, 12);
            totalKills++;
            const owner = players[b.owner];
            if (owner) { owner.kills++; owner.score += (e.points || 1) * Math.max(1, Math.floor(comboCount / 3)); }
            sfxKill();
            registerComboHit();
            if (e.maxHp >= 4) addFloatingText(e.x, e.y - e.r, '+' + (e.points || 1), e.color);
            // Slow-mo on significant kills
            if (e.maxHp >= 8) triggerSlowMo(12);
          }
          if (!b.piercing) break;
        }
      }
    }
    bullets = bullets.filter((_, i) => !deadBullets.has(i));
    enemies = enemies.filter((_, i) => !deadEnemies.has(i));

    // Friendly fire
    if (friendlyFire && numPlayers > 1) {
      for (let bi = bullets.length - 1; bi >= 0; bi--) {
        const b = bullets[bi];
        if (b.enemy) continue;
        for (const p of players) {
          if (!p.alive || p.idx === b.owner || p.invuln > 0) continue;
          if (Math.hypot(p.x - b.x, p.y - b.y) < PLAYER_R + BULLET_R) {
            if (!hasBuff(p, 'shield')) {
              p.lives--;
              p.invuln = INVULN_FRAMES;
              spawnExplosion(p.x, p.y, PCFG[p.idx].color, 6);
              sfxDamage(); addShake(5);
              addFloatingText(p.x, p.y - 20, 'Friendly fire!', '#FF6B6B');
              if (p.lives <= 0) { p.alive = false; deathExplosion(p); }
            }
            bullets.splice(bi, 1);
            break;
          }
        }
      }
    }

    // Enemy-player collisions
    for (const p of players) {
      if (!p.alive || p.invuln > 0) continue;
      for (let ei = enemies.length - 1; ei >= 0; ei--) {
        const e = enemies[ei];
        if (Math.hypot(p.x - e.x, p.y - e.y) < PLAYER_R + e.r) {
          if (hasBuff(p, 'shield')) {
            p.invuln = 15;
            enemies.splice(ei, 1);
            spawnExplosion(e.x, e.y, '#22C55E', 10);
            addFloatingText(p.x, p.y - 20, 'Geblokt!', '#22C55E');
          } else {
            p.lives--;
            p.invuln = INVULN_FRAMES;
            spawnExplosion(p.x, p.y, PCFG[p.idx].color, 8);
            enemies.splice(ei, 1);
            spawnExplosion(e.x, e.y, e.color, 6);
            sfxDamage(); addShake(8);
            if (p.lives <= 0) { p.alive = false; deathExplosion(p); }
          }
          break;
        }
      }
    }

    // Particles
    for (const pt of particles) { pt.x += pt.vx; pt.y += pt.vy; pt.vx *= 0.97; pt.vy *= 0.97; pt.life -= 0.025; }
    particles = particles.filter(pt => pt.life > 0);

    // Floating texts
    for (const ft of floatingTexts) { ft.y += ft.vy; ft.life -= 0.015; }
    floatingTexts = floatingTexts.filter(ft => ft.life > 0);

    updateHud();

    // Check game over
    if (players.every(p => !p.alive)) {
      state = 'done';
      showResults();
    }
  }

  // ===================== DRAW =====================
  function draw() {
    const c = themeColors();
    ctx.save();
    ctx.translate(shakeX, shakeY);
    drawBg(c);
    drawPowerups();
    drawTrails();
    drawBullets(c);
    // Draw boss projectiles
    for (const b of bossProjectiles) {
      ctx.fillStyle = '#FF4444'; ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    }
    drawEnemies(c);
    drawBoss(c);
    drawPlayers(c);
    drawParticles();
    drawFloatingTexts();
    drawEdgeIndicators(c);
    drawCombo(c);
    drawHudOverlay(c);
    ctx.restore();
  }

  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  // ===================== RESULTS =====================
  function showResults() {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    const t = Math.floor(frameCount / 60);
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(t % 60).padStart(2, '0');
    const topScore = sorted[0].score;

    // Save high score
    saveHighScore(topScore, waveNumber, totalKills, numPlayers);

    let html = '';
    if (numPlayers === 1) {
      html += '<span class="arena-big">Game Over!</span>';
      html += '<span class="arena-sub">Score: ' + topScore + ' pts · ' + sorted[0].kills + ' kills · Wave ' + waveNumber + ' · ' + mm + ':' + ss + '</span>';
      if (maxCombo >= 3) html += '<span class="arena-sub" style="color:#FBBF24">🔥 Max combo: ' + maxCombo + 'x</span>';
    } else {
      const winner = sorted[0];
      const cfg = PCFG[winner.idx];
      html += '<span class="arena-big" style="color:' + cfg.color + '">🏆 ' + cfg.name + ' wint!</span>';
      html += '<span class="arena-sub">';
      for (const p of sorted) {
        html += PCFG[p.idx].name + ': ' + p.score + 'pts (' + p.kills + ' kills) &nbsp; ';
      }
      html += '</span>';
      if (maxCombo >= 3) html += '<span class="arena-sub" style="color:#FBBF24">🔥 Max combo: ' + maxCombo + 'x</span>';
    }
    html += '<span class="arena-sub" style="opacity:.6;margin-top:.4rem">Wave ' + waveNumber + ' · ' + totalKills + ' kills · Druk op een beweeg-toets om opnieuw te spelen</span>';

    resultTimeoutId = setTimeout(() => {
      resultTimeoutId = null;
      overlay.classList.remove('hidden');
      msgEl.innerHTML = html;
      renderHighScores();
    }, 600);
  }

  // ===================== INPUT =====================
  const keysDown = new Set();

  document.addEventListener('keydown', (e) => {
    // Pause toggle
    if (e.code === 'Escape' && (state === 'running' || state === 'paused')) {
      e.preventDefault();
      state = state === 'paused' ? 'running' : 'paused';
      return;
    }

    // Start/restart
    if (state === 'idle' || state === 'done') {
      for (let i = 0; i < numPlayers; i++) {
        const cfg = PCFG[i];
        if ([cfg.up, cfg.down, cfg.left, cfg.right].includes(e.code)) {
          e.preventDefault();
          if (resultTimeoutId) { clearTimeout(resultTimeoutId); resultTimeoutId = null; }
          initGame();
          state = 'running';
          overlay.classList.add('hidden');
          keysDown.add(e.code);
          return;
        }
      }
    }

    if (keysDown.has(e.code)) return;
    keysDown.add(e.code);

    for (let i = 0; i < numPlayers; i++) {
      const cfg = PCFG[i];
      if ([cfg.up, cfg.down, cfg.left, cfg.right, cfg.shoot, cfg.dash].includes(e.code)) {
        e.preventDefault();
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    keysDown.delete(e.code);
  });
}

// ---------------------------------------------------------------------------
// Init on DOMContentLoaded
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initParticles();
});
