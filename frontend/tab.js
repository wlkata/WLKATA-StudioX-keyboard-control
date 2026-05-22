(function () {
  'use strict';

  var EXT = 'keyboard-control';
  var serverUrl = ExtensionAPI.getServerUrl();

  /* ── Default key bindings ─────────────────────────────────────────── */
  var DEFAULTS = {
    xPos: 'w', xNeg: 's',
    yPos: 'a', yNeg: 'd',
    zPos: 'q', zNeg: 'e',
    effOpen: 'j', effClose: 'k', effOff: 'l'
  };

  var MOVE_ACTIONS = ['xPos', 'xNeg', 'yPos', 'yNeg', 'zPos', 'zNeg'];
  var EFF_ACTIONS  = ['effOpen', 'effClose', 'effOff'];

  /* ── State ────────────────────────────────────────────────────────── */
  var bindings  = {};           // action → key (lowercase)
  var kbOn      = false;        // keyboard capture enabled
  var tabOn     = true;         // extension tab is visible
  var pressed   = {};           // key (lowercase) → true while held
  var moving    = false;        // movement cycle running
  var rebinding = null;         // action being rebound, or null

  /* ── DOM refs ─────────────────────────────────────────────────────── */
  var $robot   = document.getElementById('kb-robot');
  var $refresh = document.getElementById('kb-refresh');
  var $step    = document.getElementById('kb-step');
  var $effType = document.getElementById('kb-eff-type');
  var $toggle  = document.getElementById('kb-toggle');
  var $status  = document.getElementById('kb-status');
  var $reset   = document.getElementById('kb-reset');
  var $keyBtns = document.querySelectorAll('.kb-ctrl-key-btn');
  var $hints   = document.querySelectorAll('.kb-ctrl-hint');

  /* ── Utilities ────────────────────────────────────────────────────── */
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function getPort() { return $robot.value || undefined; }
  function getStep() { return parseFloat($step.value) || 5; }
  function setStatus(msg) { $status.textContent = msg; }

  function keyLabel(k) {
    var special = {
      ' ': 'Space', 'arrowup': '\u2191', 'arrowdown': '\u2193',
      'arrowleft': '\u2190', 'arrowright': '\u2192',
      'escape': 'Esc', 'enter': 'Enter', 'tab': 'Tab',
      'backspace': '\u232B', 'delete': 'Del',
      'shift': 'Shift', 'control': 'Ctrl', 'alt': 'Alt', 'meta': '\u2318'
    };
    if (special[k]) return special[k];
    return k.length === 1 ? k.toUpperCase() : k;
  }

  /* ── Settings persistence ─────────────────────────────────────────── */
  function loadSettings() {
    var s = ExtensionAPI.getData(EXT, 'settings');
    if (s) {
      if (s.bindings) bindings = s.bindings;
      if (s.step != null) $step.value = s.step;
      if (s.effType) $effType.value = s.effType;
    }
    // Fill defaults for any missing bindings
    for (var k in DEFAULTS) {
      if (!bindings[k]) bindings[k] = DEFAULTS[k];
    }
    syncKeyBtns();
  }

  function saveSettings() {
    ExtensionAPI.setData(EXT, 'settings', {
      bindings: bindings,
      step: $step.value,
      effType: $effType.value
    });
  }

  /* ── Robot dropdown ───────────────────────────────────────────────── */
  function refreshRobots() {
    fetch(serverUrl + '/detect-devices')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var cur = $robot.value;
        $robot.innerHTML = '<option value="">Active robot</option>';
        ((data && data.ports) || []).forEach(function (p) {
          if (!p.connected) return;
          var o = document.createElement('option');
          o.value = p.port;
          o.textContent = p.port + ' (' + p.model + ')';
          $robot.appendChild(o);
        });
        if (cur) $robot.value = cur;
      });
  }

  /* ── Jog command ──────────────────────────────────────────────────── */
  function sendJog(values) {
    var body = { mode: 'coord', values: values };
    var p = getPort();
    if (p) body.port = p;
    return fetch(serverUrl + '/cmd/jog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function jogSingle(axis, dir) {
    var v = {};
    v[axis] = getStep() * dir;
    setStatus('Jogging ' + axis.toUpperCase() + ' ' + (dir > 0 ? '+' : '') + v[axis] + ' mm \u2026');
    sendJog(v)
      .then(function () { setStatus('Done'); })
      .catch(function (e) { setStatus('Error: ' + e.message); });
  }

  /* ── End-effector command ─────────────────────────────────────────── */
  function sendEff(action) {
    var type = $effType.value;
    var endpoint, mode;

    if (type === 'gripper') {
      endpoint = '/cmd/gripper';
      // Open = release (0), Close = grip (1), Off = release (0)
      mode = (action === 'effClose') ? 1 : 0;
    } else {
      endpoint = '/cmd/pump';
      // Open = suction on (1), Close = off (0), Off = off (0)
      mode = (action === 'effOpen') ? 1 : 0;
    }

    var body = { mode: mode };
    var p = getPort();
    if (p) body.port = p;

    fetch(serverUrl + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(function () {});
  }

  /* ── Wait for robot idle ──────────────────────────────────────────── */
  async function waitIdle() {
    // Small delay so the robot has time to start processing the command
    await sleep(200);
    while (kbOn) {
      try {
        var body = {};
        var p = getPort();
        if (p) body.port = p;
        var res = await fetch(serverUrl + '/cmd/last-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        var data = await res.json();
        if (data.state === 'Idle') return;
      } catch (_) { /* retry on error */ }
      await sleep(100);
    }
  }

  /* ── Movement cycle (keyboard mode) ───────────────────────────────── *
   * 1. Read currently-pressed movement keys                             *
   * 2. Build a single multi-axis incremental jog from them              *
   * 3. Send command, wait for idle                                      *
   * 4. Loop back to 1 — if keys are still held, keep moving            *
   * ─────────────────────────────────────────────────────────────────── */
  function buildValues() {
    var s = getStep();
    var v = {};
    var any = false;

    if (pressed[bindings.xPos]) { v.x = (v.x || 0) + s; any = true; }
    if (pressed[bindings.xNeg]) { v.x = (v.x || 0) - s; any = true; }
    if (pressed[bindings.yPos]) { v.y = (v.y || 0) + s; any = true; }
    if (pressed[bindings.yNeg]) { v.y = (v.y || 0) - s; any = true; }
    if (pressed[bindings.zPos]) { v.z = (v.z || 0) + s; any = true; }
    if (pressed[bindings.zNeg]) { v.z = (v.z || 0) - s; any = true; }

    if (!any) return null;

    // Remove axes where +/- cancelled out to zero
    for (var k in v) {
      if (v[k] === 0) delete v[k];
    }
    return Object.keys(v).length ? v : null;
  }

  async function moveCycle() {
    if (moving) return;
    moving = true;

    try {
      while (kbOn) {
        var v = buildValues();
        if (!v) break;

        // Build human-readable status
        var parts = [];
        for (var k in v) {
          parts.push(k.toUpperCase() + ' ' + (v[k] > 0 ? '+' : '') + v[k]);
        }
        setStatus('Moving ' + parts.join(', ') + ' mm \u2026');

        await sendJog(v);
        await waitIdle();
        // After idle, loop checks if movement keys are still held
      }
    } catch (e) {
      setStatus('Error: ' + e.message);
    }

    moving = false;
    if (kbOn) setStatus('Keyboard active');
  }

  /* ── UI sync helpers ──────────────────────────────────────────────── */
  function syncKeyBtns() {
    $keyBtns.forEach(function (btn) {
      var act = btn.getAttribute('data-bind');
      btn.textContent = keyLabel(bindings[act] || '?');
      btn.classList.remove('kb-ctrl-key-listen');
    });
    updateHints();
  }

  function updateHints() {
    $hints.forEach(function (h) {
      var act = h.getAttribute('data-hint');
      h.textContent = kbOn ? keyLabel(bindings[act]) : '';
    });
  }

  function updateHighlights() {
    // Key-binding chip buttons
    $keyBtns.forEach(function (btn) {
      var act = btn.getAttribute('data-bind');
      btn.classList.toggle('kb-ctrl-key-pressed', !!pressed[bindings[act]]);
    });
    // Jog buttons
    document.querySelectorAll('.kb-ctrl-jog-btn').forEach(function (btn) {
      var act = btn.getAttribute('data-action');
      if (act) btn.classList.toggle('kb-ctrl-pressed', !!pressed[bindings[act]]);
    });
    // Effector buttons
    document.querySelectorAll('.kb-ctrl-eff-btn').forEach(function (btn) {
      var act = btn.getAttribute('data-action');
      if (act) btn.classList.toggle('kb-ctrl-pressed', !!pressed[bindings[act]]);
    });
  }

  /* ── Key-binding editor ───────────────────────────────────────────── */
  function startRebind(btn) {
    if (rebinding) cancelRebind();
    rebinding = btn.getAttribute('data-bind');
    btn.classList.add('kb-ctrl-key-listen');
    btn.textContent = '\u2026';
  }

  function finishRebind(key) {
    // Swap if the key is already used by another action
    for (var a in bindings) {
      if (a !== rebinding && bindings[a] === key) {
        bindings[a] = bindings[rebinding];
        break;
      }
    }
    bindings[rebinding] = key;
    rebinding = null;
    syncKeyBtns();
    saveSettings();
  }

  function cancelRebind() {
    rebinding = null;
    syncKeyBtns();
  }

  /* ── Keyboard event handlers ──────────────────────────────────────── */
  document.addEventListener('keydown', function (e) {
    // Rebinding takes priority over everything
    if (rebinding) {
      e.preventDefault();
      if (e.key === 'Escape') {
        cancelRebind();
      } else {
        finishRebind(e.key.toLowerCase());
      }
      return;
    }

    if (!kbOn || !tabOn) return;

    // Don't capture when user is typing in an input
    var tag = (e.target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    var key = e.key.toLowerCase();

    // Find which action this key maps to
    var action = null;
    for (var a in bindings) {
      if (bindings[a] === key) { action = a; break; }
    }
    if (!action) return;

    e.preventDefault();

    // Ignore held-key repeat events
    if (pressed[key]) return;
    pressed[key] = true;
    updateHighlights();

    // End-effector: fire immediately, no waiting
    if (EFF_ACTIONS.indexOf(action) >= 0) {
      sendEff(action);
      return;
    }

    // Movement: start the move-wait-repeat cycle if not already running
    if (!moving) {
      moveCycle();
    }
  });

  document.addEventListener('keyup', function (e) {
    delete pressed[e.key.toLowerCase()];
    updateHighlights();
  });

  // Clear all pressed keys when window loses focus (keyup events won't fire)
  window.addEventListener('blur', function () {
    pressed = {};
    updateHighlights();
  });

  /* ── Button click handlers ────────────────────────────────────────── */
  // Jog buttons
  document.querySelectorAll('.kb-ctrl-jog-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      jogSingle(btn.dataset.axis, parseInt(btn.dataset.dir, 10));
    });
  });

  // End-effector buttons
  document.querySelectorAll('.kb-ctrl-eff-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var map = { open: 'effOpen', close: 'effClose', off: 'effOff' };
      sendEff(map[btn.dataset.eff]);
    });
  });

  // Key-binding buttons (click to rebind)
  $keyBtns.forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      startRebind(btn);
    });
  });

  // Click anywhere else cancels rebinding
  document.addEventListener('click', function (e) {
    if (rebinding && !e.target.classList.contains('kb-ctrl-key-btn')) {
      cancelRebind();
    }
  });

  // Refresh robot list
  $refresh.addEventListener('click', refreshRobots);

  // Reset key bindings to defaults
  $reset.addEventListener('click', function () {
    bindings = {};
    for (var k in DEFAULTS) bindings[k] = DEFAULTS[k];
    syncKeyBtns();
    saveSettings();
  });

  // Keyboard capture toggle
  $toggle.addEventListener('change', function () {
    kbOn = $toggle.checked;
    pressed = {};
    updateHighlights();
    updateHints();
    if (kbOn) {
      setStatus('Keyboard active');
    } else {
      moving = false;
      setStatus('');
    }
  });

  // Save on step / effector-type change
  $step.addEventListener('change', saveSettings);
  $effType.addEventListener('change', saveSettings);

  /* ── Tab lifecycle ────────────────────────────────────────────────── */
  ExtensionAPI.onActivate(EXT, function () {
    tabOn = true;
    refreshRobots();
  });

  ExtensionAPI.onDeactivate(EXT, function () {
    tabOn = false;
    pressed = {};
    updateHighlights();
  });

  /* ── Initialise ───────────────────────────────────────────────────── */
  loadSettings();
  refreshRobots();
})();