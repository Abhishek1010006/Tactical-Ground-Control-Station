/**
 * ==============================================================================
 * electron/js/attack-flow.js — Autonomous Attack Flow Controller
 * ==============================================================================
 * Manages the UI logic for the 'Parallel Attack System' mode. It handles:
 *  - Toggling between SWARM and ATTACK operating modes.
 *  - Monitoring and displaying the GPS position of the Surveillance UAV.
 *  - Executing LAUNCH ATTACK commands to intercept the surveillance target.
 *  - Rendering active attack mission cards in the right-hand panel.
 *  - Sending RTL (Return to Launch) and DROP commands to attack drones.
 * ==============================================================================
 */
(function () {
  const attacks = [];
  let sequence = 0;
  let currentMode = null;

  // Tracks drones returning home: Map<droneId, attackId>
  const returningDrones = new Map();
  // Attack IDs that have completed RTL and are confirmed home
  const attackHomeStates = new Set();

  // --------------------------------------------------------------------------
  // UTILITIES & STATE
  // --------------------------------------------------------------------------

  function ready(fn) {
    const timer = setInterval(() => {
      if (typeof map !== 'undefined' && map && document.getElementById('btn-launch-attack')) {
        clearInterval(timer);
        fn();
      }
    }, 100);
  }

  function navModeFromButton(button) {
    const label = (button.textContent || '').toUpperCase();
    return label.includes('SWARM') ? 'swarm' : 'attack';
  }

  function modeLabel(mode) {
    return mode === 'attack' ? '2 (Autonomous Attack)' : '1 (Swarming)';
  }

  function isTerminalAttackStatus(status) {
    return ['complete', 'completed', 'done', 'recalled', 'rtl', 'landed', 'failed', 'dropped_enroute'].includes(
      String(status || '').toLowerCase()
    );
  }

  function markAttackTerminal(attack, status) {
    attack.status = status || attack.status;
    if (!attack.completedAt) attack.completedAt = Date.now();
  }

  function assignedDroneForTarget(target) {
    const value = target?.assigned_drone ?? target?.assignedDroneId ?? target?.droneId;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  async function setBackendMode(mode) {
    const res = await fetch(`${BASE_URL}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Mode change failed');
    currentMode = data.operating_mode;
    return data;
  }

  function surveillancePosition() {
    const survId = appState.roles.surveillance;
    if (!survId) return null;
    const d = appState.drones[survId];
    if (!d || d.lat == null || d.lon == null) return null;
    return { lat: d.lat, lon: d.lon, survId };
  }

  function activeAttackDroneIds() {
    return new Set(
      attacks
        .filter(attack => attack.droneId && !isTerminalAttackStatus(attack.status))
        .map(attack => Number(attack.droneId))
    );
  }

  function availableAttackDroneIds() {
    const busy = activeAttackDroneIds();
    return (appState.roles.attack || [])
      .map(Number)
      .filter(id => Number.isFinite(id) && !busy.has(id));
  }

  // --------------------------------------------------------------------------
  // SURVEILLANCE TARGET DISPLAY (text chip only — no map marker)
  // --------------------------------------------------------------------------

  function updateSurveillanceTargetDisplay() {
    const el = document.getElementById('selected-attack-target');
    if (!el) return;

    if (currentMode !== 'attack') {
      el.innerText = 'SELECT ATTACK MODE IN TOP NAV';
      el.className = 'empty-chip';
      return;
    }

    if (!appState.roles.surveillance) {
      el.innerText = 'SELECT SURVEILLANCE UAV (DROPDOWN)';
      el.className = 'empty-chip';
      return;
    }

    const pos = surveillancePosition();
    if (!pos) {
      el.innerText = `SURV UAV #${appState.roles.surveillance} — AWAITING GPS`;
      el.className = 'empty-chip';
      return;
    }

    el.innerText = `ATTACK AT SURV #${pos.survId}: ${pos.lat.toFixed(6)}N, ${pos.lon.toFixed(6)}E`;
    el.className = 'chip';
  }

  // --------------------------------------------------------------------------
  // MISSION SYNC & MODE SWITCHING
  // --------------------------------------------------------------------------

  function syncAttacksFromMission(targets) {
    if (!Array.isArray(targets)) targets = Array.isArray(appState?.targets) ? appState.targets : [];

    for (let i = attacks.length - 1; i >= 0; i--) {
      const target = targets.find(tgt => tgt.id === attacks[i].targetId);
      if (target && isTerminalAttackStatus(target.status)) {
        markAttackTerminal(attacks[i], target.status);
      }
    }

    targets.forEach(tgt => {
      const assignedDrone = assignedDroneForTarget(tgt);

      const existing = attacks.find(a => a.targetId === tgt.id);
      if (existing) {
        existing.lat = tgt.lat;
        existing.lon = tgt.lon;
        existing.droneId = assignedDrone || existing.droneId;
        if (isTerminalAttackStatus(tgt.status)) markAttackTerminal(existing, tgt.status);
        else {
          existing.status = tgt.status;
          existing.completedAt = null;
        }
        return;
      }
      if (tgt.source === 'surveillance' || tgt.source === 'SERVER' || assignedDrone) {
        attacks.push({
          id: ++sequence,
          targetId: tgt.id,
          label: `Attack-${tgt.id}`,
          droneId: assignedDrone,
          lat: tgt.lat,
          lon: tgt.lon,
          status: tgt.status || 'enroute',
          completedAt: isTerminalAttackStatus(tgt.status) ? Date.now() : null
        });
      }
    });
    for (let i = attacks.length - 1; i >= 0; i--) {
      const newerIndex = attacks.findIndex((attack, index) =>
        index > i && attack.droneId && attack.droneId === attacks[i].droneId
      );
      if (newerIndex !== -1) attacks.splice(i, 1);
    }
    renderAttackCards();
  }

  async function applyMode(button, mode, name) {
    if (window.requireApiReadyForAction && !(await window.requireApiReadyForAction(name))) return;
    if (window.requireFleetLinked && !window.requireFleetLinked(name)) return;

    document.querySelectorAll('.nav-center .btn-nav').forEach(item => item.classList.remove('active'));
    button.classList.add('active');

    if (window.gcsTerminal) {
      window.gcsTerminal.println(`>> ${name} — main.py option ${modeLabel(mode)}`, 'ui');
    }

    try {
      await setBackendMode(mode);
      if (window.gcsTerminal) {
        window.gcsTerminal.println(`>> ${name} mode active.`, 'ok');
      }
      showToast('success', `${name} MODE`, mode === 'attack'
        ? 'Parallel attack system armed — select surveillance UAV'
        : 'Swarm mode selected');
      updateSurveillanceTargetDisplay();
    } catch (error) {
      button.classList.remove('active');
      if (window.gcsTerminal) window.gcsTerminal.error(error.message, name);
      showToast('error', 'MODE CHANGE FAILED', error.message);
    }
  }

  // --------------------------------------------------------------------------
  // INITIALIZATION & EVENT BINDING
  // --------------------------------------------------------------------------

  ready(() => {
    document.querySelectorAll('.nav-center .btn-nav').forEach(button => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const mode = navModeFromButton(button);
        const name = mode === 'attack' ? 'ATTACK' : 'SWARM';

        if (window.requireFleetLinked && !window.requireFleetLinked(name)) {
          button.classList.remove('active');
          return;
        }

        const confirm = window.confirmGcsAction;
        if (!confirm) {
          applyMode(button, mode, name);
          return;
        }

        confirm(
          'CONFIRM ACTION',
          `Proceed with <b>${name}</b>?`,
          () => applyMode(button, mode, name),
          () => button.classList.remove('active')
        );
      });
    });

    document.getElementById('role-surv-select').addEventListener('change', () => {
      updateSurveillanceTargetDisplay();
    });

    document.getElementById('btn-launch-attack').addEventListener('click', () => {
      if (!validateAttackLaunch()) return;

      const confirm = window.confirmGcsAction;
      if (!confirm) {
        executeLaunchAttack();
        return;
      }

      confirm(
        'CONFIRM ACTION',
        'Proceed with <b>LAUNCH ATTACK</b>?',
        () => executeLaunchAttack()
      );
    });

    setInterval(updateSurveillanceTargetDisplay, 1000);
    updateSurveillanceTargetDisplay();

    // --- Home-detection poll (every 2s) ---
    // When a returning drone disarms at low altitude, mark it as HOME
    setInterval(() => {
      if (!returningDrones.size) return;
      let changed = false;
      returningDrones.forEach((attackId, droneId) => {
        const d = appState?.drones?.[droneId];
        if (!d) return;
        const isArmed = !!d.armed;
        const alt    = typeof d.alt === 'number' ? d.alt : 99;
        if (!isArmed && alt < 2.0) {
          // Drone has disarmed on the ground — RTL complete
          attackHomeStates.add(attackId);
          returningDrones.delete(droneId);
          changed = true;
          if (window.gcsTerminal) {
            window.gcsTerminal.println(`>> UAV #${droneId} — returned to base ✅`, 'ok');
          }
          showToast('success', `UAV #${droneId} 🏠 HOME`, 'Drone has landed at launch point');
        }
      });
      if (changed) renderAttackCards();
    }, 2000);
  });

  // --------------------------------------------------------------------------
  // ATTACK EXECUTION & CARDS
  // --------------------------------------------------------------------------

  function validateAttackLaunch() {
    if (window.requireFleetLinked && !window.requireFleetLinked('LAUNCH ATTACK')) return false;

    if (currentMode !== 'attack') {
      const msg = 'Select ATTACK in the top navbar first.';
      if (window.gcsTerminal) window.gcsTerminal.warn(msg);
      showToast('warn', 'SELECT ATTACK MODE', msg);
      return false;
    }

    if (!appState.roles.surveillance) {
      const msg = 'Select a surveillance UAV in the dropdown.';
      if (window.gcsTerminal) window.gcsTerminal.warn(msg);
      showToast('warn', 'SELECT SURVEILLANCE UAV', msg);
      return false;
    }

    const pos = surveillancePosition();
    if (!pos) {
      const msg = 'Waiting for GPS telemetry from the surveillance UAV.';
      if (window.gcsTerminal) window.gcsTerminal.warn(msg);
      showToast('warn', 'NO SURVEILLANCE GPS', msg);
      return false;
    }

    if (!availableAttackDroneIds().length) {
      const msg = 'All attack drones are already assigned. Recall one before launching another attack.';
      if (window.gcsTerminal) window.gcsTerminal.warn(msg);
      showToast('warn', 'NO FREE ATTACK UAV', msg);
      return false;
    }

    return true;
  }

  async function executeLaunchAttack() {
    if (window.requireApiReadyForAction && !(await window.requireApiReadyForAction('LAUNCH ATTACK'))) return;
    if (window.requireFleetLinked && !window.requireFleetLinked('LAUNCH ATTACK')) return;

    const alt = parseFloat(document.getElementById('attack-alt-input').value) || 10;
    if (window.gcsTerminal) {
      window.gcsTerminal.println('>> LAUNCH ATTACK — parallel_attack_system (surveillance GPS target)...', 'ui');
    }

    try {
      await fetch(`${BASE_URL}/attack_alt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ altitude: alt })
      });
    } catch (e) {
      if (window.gcsTerminal) window.gcsTerminal.warn(`Could not set attack altitude: ${e.message}`);
    }

    try {
      const res = await fetch(`${BASE_URL}/attack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Attack launch failed');

      const tgt = data.target;
      const assignedDroneId = Number(data.attacker_id);
      if (activeAttackDroneIds().has(assignedDroneId)) {
        throw new Error(`UAV #${assignedDroneId} is already assigned to an active attack. Recall it before reuse.`);
      }

      const attack = {
        id: ++sequence,
        targetId: tgt.id,
        label: `Attack-${tgt.id}`,
        droneId: assignedDroneId,
        lat: tgt.lat,
        lon: tgt.lon,
        status: tgt.status || 'enroute'
      };
      attacks.push(attack);
      upsertAppStateTarget({
        id: tgt.id,
        lat: tgt.lat,
        lon: tgt.lon,
        alt,
        source: 'surveillance',
        assignedDroneId,
        status: attack.status,
        time: tgt.time || Date.now() / 1000
      });
      renderAttackCards();
      if (window.gcsTerminal) {
        window.gcsTerminal.println(`>> Attack launched — UAV #${attack.droneId} en route.`, 'ok');
      }
      showToast('success', attack.label.toUpperCase() + ' LAUNCHED',
        `UAV #${attack.droneId} → surv position ${attack.lat.toFixed(5)}N`);
    } catch (error) {
      if (window.gcsTerminal) window.gcsTerminal.error(error.message, 'LAUNCH ATTACK');
      showToast('error', 'ATTACK LAUNCH FAILED', error.message);
    }
  }

  function upsertAppStateTarget(target) {
    if (!Array.isArray(appState.targets)) appState.targets = [];
    const existing = appState.targets.find(item => item.id === target.id);
    if (existing) {
      Object.assign(existing, target);
    } else {
      appState.targets.push(target);
    }
  }

  function renderAttackCards() {
    const container = document.getElementById('right-mission-overview');
    if (!container) return;
    const visibleAttacks = attacks.slice();
    if (!visibleAttacks.length) {
      const fallbackTargets = (appState?.targets || []).filter(target =>
        assignedDroneForTarget(target)
      );
      if (fallbackTargets.length) {
        fallbackTargets.forEach(target => attacks.push({
          id: ++sequence,
          targetId: target.id,
          label: `Attack-${target.id}`,
          droneId: assignedDroneForTarget(target),
          lat: target.lat,
          lon: target.lon,
          status: target.status || 'enroute',
          completedAt: isTerminalAttackStatus(target.status) ? Date.now() : null
        }));
        return renderAttackCards();
      }
      container.innerHTML = '<div class="ms-empty-msg">NO ACTIVE ASSIGNMENTS</div>';
      return;
    }
    container.innerHTML = visibleAttacks.map(missionCardHtml).join('');
    bindAttackButtons(container);
  }

  function missionCardHtml(attack) {
    const drone = appState?.drones?.[attack.droneId];
    const battery = drone?.battery != null ? `${drone.battery}%` : '--';
    const mode = drone?.mode != null && typeof getModeString === 'function' ? getModeString(drone.mode) : '--';

    // Override everything with HOME state if detected
    const isHome     = attackHomeStates.has(attack.id);
    const isTerminal = isHome || isTerminalAttackStatus(attack.status);
    const statusKey  = isHome ? 'home' : String(attack.status || 'enroute').toLowerCase();
    const statusClass  = missionStatusClass(statusKey, isTerminal);
    const terminalNote = missionTerminalNote(statusKey);
    const statusLabel  = isHome ? 'HOME' : (attack.status || 'enroute').toUpperCase();

    // Only show DROP + RTL when active (not terminal, not returning home)
    const actionHtml = isTerminal
      ? `<div class="rm-terminal-note ${statusClass}">${terminalNote}</div>`
      : `<div class="quick-actions quick-actions-active" style="margin-top:8px;">
           <button class="btn btn-ghost btn-amber" data-attack-drop="${attack.id}">💥 DROP</button>
           <button class="btn btn-ghost" data-attack-rtl="${attack.id}">🏠 RTL</button>
         </div>`;

    return `
      <div class="rm-card">
        <div class="rm-header">
          <span class="rm-title">${attack.label}</span>
          <span class="rm-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="rm-row"><span>UAV ASSIGNED</span><span class="rm-val">#${attack.droneId}</span></div>
        <div class="rm-row"><span>BATTERY</span><span class="rm-val">${battery}</span></div>
        <div class="rm-row"><span>MODE</span><span class="rm-val">${mode}</span></div>
        <div class="rm-row"><span>TARGET</span><span class="rm-val">${attack.lat.toFixed(5)}N, ${attack.lon.toFixed(5)}E</span></div>
        ${actionHtml}
      </div>
    `;
  }

  function missionStatusClass(status, isTerminal) {
    if (status === 'home')                                              return 'home';
    if (status === 'completed' || status === 'complete' || status === 'done') return 'done';
    if (status === 'recalled' || status === 'rtl')                      return 'recalled';
    if (status === 'failed')                                            return 'failed';
    if (status === 'dropped_enroute')                                   return 'dropped-enroute';
    return isTerminal ? 'done' : 'engaged';
  }

  function missionTerminalNote(status) {
    if (status === 'home')           return '🏠 RETURNED TO BASE';
    if (status === 'recalled' || status === 'rtl') return 'RECALLED — RTL IN PROGRESS';
    if (status === 'failed')         return 'MISSION FAILED';
    if (status === 'dropped_enroute') return '↓ DROPPED EN-ROUTE — NOT ON TARGET';
    return 'PAYLOAD DROPPED — RETURNING HOME';
  }

  function bindAttackButtons(container) {
    container.querySelectorAll('[data-attack-rtl]').forEach(btn => {
      btn.addEventListener('click', () => commandAttack(Number(btn.dataset.attackRtl), 'rtl'));
    });
    container.querySelectorAll('[data-attack-drop]').forEach(btn => {
      btn.addEventListener('click', () => commandAttack(Number(btn.dataset.attackDrop), 'drop'));
    });
  }

  async function commandAttack(id, action) {
    if (window.requireFleetLinked && !window.requireFleetLinked(`ATTACK ${action.toUpperCase()}`)) return;
    const attack = attacks.find(item => item.id === id);
    if (!attack) return;
    try {
      await sendCommand(action, attack.droneId);

      let terminalStatus;
      if (action === 'drop') {
        // Capture drone's current position — this is an en-route drop
        const drone = appState?.drones?.[attack.droneId];
        if (drone && drone.lat != null && drone.lon != null) {
          if (typeof window.placeDropMarker === 'function') {
            window.placeDropMarker(attack.droneId, attack.targetId, drone.lat, drone.lon);
          }
          terminalStatus = 'dropped_enroute';
        } else {
          terminalStatus = 'completed';
        }
      } else {
        terminalStatus = 'recalled';
      }

      markAttackTerminal(attack, terminalStatus);
      // Register drone as returning so home-detection poll can track it
      returningDrones.set(attack.droneId, attack.id);
      // Also update appState target so arrival detection stops
      if (Array.isArray(appState?.targets)) {
        const tgt = appState.targets.find(t => t.id === attack.targetId);
        if (tgt) tgt.status = terminalStatus;
      }
      renderAttackCards();
      if (window.gcsTerminal) {
        const msg = action === 'drop'
          ? `>> ${attack.label} — DROP sent to UAV #${attack.droneId}. Drop location marked on map.`
          : `>> ${attack.label} — RTL sent to UAV #${attack.droneId}. Monitoring return…`;
        window.gcsTerminal.println(msg, 'ok');
      }
      showToast(
        action === 'drop' ? 'success' : 'info',
        `${attack.label.toUpperCase()} ${action.toUpperCase()}`,
        action === 'drop'
          ? `UAV #${attack.droneId} — payload dropped en-route, returning home`
          : `UAV #${attack.droneId} — returning to launch`
      );
    } catch (error) {
      if (window.gcsTerminal) window.gcsTerminal.error(error.message, `ATTACK ${action.toUpperCase()}`);
      showToast('error', 'COMMAND FAILED', error.message);
    }
  }

  window.attackFlowSyncFromMission = syncAttacksFromMission;
  window.attackFlowApplyMode = applyMode;
})();
