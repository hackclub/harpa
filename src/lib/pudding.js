// @ts-nocheck

const NAP_DELAY_MS = 1200;
const WAKE_MS = 1500;
const CALM = 0.4;
const STARTLE_MS = 550;
const MAX_HOP_PX = 18;
const MAX_DUCK_PX = 14;
const MAX_LEAN_DEG = 14;
const MAX_SWELL = 1.08;
const FACE_TRAVEL_PX = 1.5;
const POINTER_REACH_PX = 160;
const POINTER_HOLD_MS = 2500;
const MOVE_BLEND_MS = 350;
const MOVE_HOLD_MS = 3000;
const QUIET = 0.3;
const LOUD = 0.7;
const NOTE_GAP_MS = 900;
const PEAK_GAP_S = 0.4;
const SLOW_WINDOW_S = 2;
const FAST_WINDOW_S = 0.3;
const MIN_RANGE = 24;
const PEAK_RISE = 0.28;
const MAX_PLAYBACK_STEP = 40;

const MOVES = {
    sway: { pace: 0.5, happy: true, pose: (b, s, d, e) => ({ x: s * 3, y: -b, r: s * (6 + 4 * e) }) },
    bob: { pace: 1, pose: (b, s, d, e) => ({ y: -b * (3 + 5 * e), r: s * 2, nod: b * (1 + 1.5 * e) }) },
    shimmy: { pace: 1.1, pose: (b, s, d, e) => ({ x: s * (6 + 6 * e), y: -b * 2, r: -s * 3 }) },
    hop: { pace: 1, pose: (b, s, d, e) => ({ y: -b * (6 + 11 * e), r: s * (3 + 5 * e) }) },
    lean: { pace: 0.8, look: 1, pose: (b, s, d, e) => ({ y: -b * (2 + 4 * e), r: 8 + s * 2 }) },
    shake: { pace: 1.7, pose: (b, s, d, e) => ({ x: d * 2, y: -b * (3 + 6 * e), r: d * (3 + 5 * e) }) },
    rock: { pace: 0.6, pose: (b, s, d, e) => ({ x: -s * 4, y: -b * 1.5, r: s * (9 + 3 * e) }) },
    peek: { pace: 0.45, look: 1, pose: (b, s) => ({ y: 12 - b * 14, r: s * 4 }) },
    waddle: { pace: 0.9, pose: (b, s, d, e) => ({ x: s * (5 + 3 * e), y: -b * (2 + 3 * e), r: s * (8 + 3 * e) }) },
    twist: { pace: 1, pose: (b, s, d, e) => ({ x: -d * 2, y: -b * 2, r: d * (7 + 5 * e) }) },
    scoot: { pace: 0.6, happy: true, pose: (b, s, d, e) => ({ x: s * (12 + 4 * e), y: -Math.abs(d) * (3 + 3 * e), r: s * 3 }) },
    stomp: { pace: 1.2, pose: (b, s, d, e) => ({ y: -b * (5 + 9 * e), r: clamp(s * 3, -1, 1) * (5 + 4 * e) }) },
    headbang: { pace: 1.5, pose: (b, s, d, e) => ({ y: -(b ** 3) * (10 + 8 * e), nod: (1 - b) * 2 }) },
};
const MOVES_BY_LOUDNESS = [
    ["sway", "lean", "bob", "rock", "peek"],
    ["bob", "shimmy", "hop", "lean", "waddle", "twist", "scoot"],
    ["hop", "shake", "shimmy", "stomp", "headbang", "twist"],
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const spring = (k, c) => ({ x: 0, v: 0, k, c });

function settle(s, target, dt) {
    s.v += (s.k * (target - s.x) - s.c * s.v) * dt;
    s.x += s.v * dt;
}

function boxAverage(values, radius) {
    const sums = new Float64Array(values.length + 1);
    values.forEach((v, i) => { sums[i + 1] = sums[i] + v; });
    return values.map((_, i) => {
        const from = Math.max(0, i - radius);
        const to = Math.min(values.length, i + radius + 1);
        return (sums[to] - sums[from]) / (to - from);
    });
}

export function buildWave(samples, durationMs) {
    if (!samples?.length || !durationMs) return null;
    const perSecond = samples.length / (durationMs / 1000);
    const slow = boxAverage(samples, Math.max(1, Math.round((SLOW_WINDOW_S * perSecond) / 2)));
    const fast = boxAverage(samples, Math.max(0, Math.round((FAST_WINDOW_S * perSecond) / 2)));

    const sorted = [...slow].sort((a, b) => a - b);
    const low = sorted[Math.floor(sorted.length * 0.1)];
    const high = sorted[Math.floor(sorted.length * 0.95)];
    const range = Math.max(high - low, MIN_RANGE);
    const lo = (low + high - range) / 2;
    const scale = (v) => (v - lo) / range;

    const energy = slow.map((v) => clamp(scale(v), 0, 1));
    const peaks = new Float32Array(samples.length);
    const gap = Math.ceil(PEAK_GAP_S * perSecond);
    let lastPeak = -gap;
    for (let i = 1; i < samples.length; i++) {
        const rise = scale(fast[i]) - scale(slow[i]);
        const crossed = rise > PEAK_RISE && scale(fast[i - 1]) - scale(slow[i - 1]) <= PEAK_RISE;
        if (crossed && i - lastPeak >= gap) {
            peaks[i] = Math.min(1, rise);
            lastPeak = i;
        }
    }
    return { energy, peaks };
}

export function createPudding({ root, spikes, head, expression, notes, reduced }) {
    let wave = null;
    let waveId = null;
    let request = null;
    let lastIndex = -1;

    let awake = 0;
    let level = CALM;
    let phase = 0;
    let lastPosition = 0;
    let positionAt = 0;
    let stoppedAt = -Infinity;
    let wasPlaying = false;
    let wokenUntil = 0;
    let blinkAt = 3000;
    let blinkUntil = 0;
    let noteAt = 0;
    let noteIndex = 0;
    let now = 0;
    let moveName = "bob";
    let moveTier = 1;
    let movedAt = -Infinity;
    let moveUntil = 0;
    let pace = 1;
    let pose = { x: 0, y: 0, r: 0, nod: 0 };
    let from = pose;
    let pointer = null;
    let pointerAt = -Infinity;
    let glanceAt = 8000;
    let glanceUntil = 0;
    let startledUntil = 0;
    let holdStill = false;

    const shapes = Object.fromEntries(
        ["shut", "happy", "wide", "wow"].map((name) => [name, expression.querySelector(`.${name}`)]),
    );

    const jump = spring(120, 9);
    const squash = spring(320, 15);
    const lean = spring(70, 3.2);
    const swell = spring(170, 10);
    const gazeX = spring(90, 12);
    const gazeY = spring(90, 12);

    function chooseMove(t) {
        const tier = level < QUIET ? 0 : level > LOUD ? 2 : 1;
        const shifted = tier !== moveTier && t - movedAt > MOVE_HOLD_MS;
        if (!shifted && t < moveUntil) return;
        const options = MOVES_BY_LOUDNESS[tier].filter((name) => name !== moveName);
        moveName = options[Math.floor(Math.random() * options.length)];
        moveTier = tier;
        from = pose;
        movedAt = t;
        moveUntil = t + 7000 + Math.random() * 5000;
    }

    function gazeTarget(t, dozing, grooving) {
        if (dozing) return { x: 0, y: 0 };
        if (pointer && t - pointerAt < POINTER_HOLD_MS) return pointer;
        if (grooving && MOVES[moveName].look) return { x: MOVES[moveName].look, y: 0 };
        if (t > glanceAt) {
            glanceUntil = t + 1500;
            glanceAt = t + 8000 + Math.random() * 6000;
        }
        return { x: t < glanceUntil ? 1 : 0, y: 0 };
    }

    function express(t, dozing, playing) {
        const startled = t < startledUntil;
        const shut = dozing || t < blinkUntil;
        const happy = playing && MOVES[moveName].happy;
        const shown = {
            wide: startled,
            shut: !startled && shut,
            happy: !startled && !shut && happy,
            wow: startled,
        };
        for (const name in shapes) shapes[name].style.opacity = shown[name] ? 1 : 0;
    }

    function onPointer(e) {
        const box = root.getBoundingClientRect();
        pointer = {
            x: clamp((e.clientX - box.left - box.width / 2) / POINTER_REACH_PX, -1, 1),
            y: clamp((e.clientY - box.top - box.height / 3) / POINTER_REACH_PX, -1, 1),
        };
        pointerAt = now;
    }

    if (!reduced) window.addEventListener("pointermove", onPointer);

    function popNote() {
        const span = notes?.children[noteIndex++ % notes.children.length];
        if (!span || reduced || now < noteAt) return;
        noteAt = now + NOTE_GAP_MS;
        const x = -36 + Math.random() * 72;
        const tilt = -24 + Math.random() * 48;
        span.animate(
            [
                { opacity: 0, transform: "translate(0, 12px) scale(0.6) rotate(0deg)" },
                { opacity: 1, offset: 0.18 },
                { opacity: 0, transform: `translate(${x}px, -52px) scale(1.1) rotate(${tilt}deg)` },
            ],
            { duration: 1300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
    }

    function loudness(position, duration) {
        if (!wave || !duration) {
            lastIndex = -1;
            return CALM;
        }
        const n = wave.energy.length;
        const index = clamp(Math.floor((position / duration) * n), 0, n - 1);
        if (lastIndex >= 0 && index > lastIndex && index - lastIndex < MAX_PLAYBACK_STEP) {
            for (let i = lastIndex + 1; i <= index; i++) {
                if (wave.peaks[i]) {
                    swell.v += 0.2 + wave.peaks[i] * 0.4;
                    squash.v -= 0.5;
                    popNote();
                }
            }
        }
        lastIndex = index;
        return wave.energy[index];
    }

    function tick(t, dtMs, { playing, position, duration, still }) {
        now = t;
        const dt = dtMs / 1000;
        holdStill = still;
        const grooving = playing && !still;

        if (position !== lastPosition) {
            lastPosition = position;
            positionAt = t;
        }
        if (wasPlaying && !playing) stoppedAt = t;
        if (!wasPlaying && playing) {
            stoppedAt = Infinity;
            if (awake < 0.5) hop();
        }
        wasPlaying = playing;

        const dozing = !playing && t - stoppedAt > NAP_DELAY_MS && t > wokenUntil;
        root.classList.toggle("asleep", dozing);
        if (t > blinkAt) {
            blinkUntil = t + 130;
            blinkAt = t + 2500 + Math.random() * 3500;
        }
        express(t, dozing, grooving);
        if (reduced) return;

        awake += ((dozing ? 0 : 1) - awake) * (1 - Math.exp(-dtMs / (dozing ? 700 : 180)));

        const live = playing ? position + Math.min(t - positionAt, 1500) : position;
        const heard = grooving ? loudness(live, duration) : 0;
        const tau = heard > level ? 150 : 600;
        level += (heard - level) * (1 - Math.exp(-dtMs / tau));

        const dancing = grooving ? awake : 0;
        if (grooving) chooseMove(t);
        const move = MOVES[moveName];
        pace += (move.pace - pace) * (1 - Math.exp(-dtMs / 400));
        phase = (phase + dt * (1.2 + level) * pace) % 2;
        const bounce = Math.abs(Math.sin(Math.PI * phase));
        const sway = Math.sin(Math.PI * phase);
        const double = Math.sin(2 * Math.PI * phase);

        const aim = { x: 0, y: 0, r: 0, nod: 0, ...move.pose(bounce, sway, double, level) };
        const mix = 1 - (1 - clamp((t - movedAt) / MOVE_BLEND_MS, 0, 1)) ** 3;
        pose = {
            x: from.x + (aim.x - from.x) * mix,
            y: from.y + (aim.y - from.y) * mix,
            r: from.r + (aim.r - from.r) * mix,
            nod: from.nod + (aim.nod - from.nod) * mix,
        };

        const gaze = gazeTarget(t, dozing, grooving);
        settle(jump, 0, dt);
        settle(squash, 0, dt);
        settle(lean, 0, dt);
        settle(swell, grooving ? 0.01 + level * 0.05 : 0, dt);
        settle(gazeX, gaze.x, dt);
        settle(gazeY, gaze.y, dt);

        const land = (1 - bounce) ** 4 * (0.02 + 0.08 * level) * dancing;
        const breath = Math.sin(t * 0.0014) * 0.012 * (1 - awake);
        const scaleY = clamp(1 - land + breath + squash.x, 0.78, 1.2);
        const scaleX = 1 / Math.sqrt(scaleY);
        const size = clamp(1 + swell.x, 1, MAX_SWELL);
        const x = pose.x * dancing;
        const y = clamp(jump.x + pose.y * dancing, -MAX_HOP_PX, MAX_DUCK_PX) + (1 - awake) * 3;
        const r = clamp(pose.r * dancing + lean.x - (1 - awake) * 4, -MAX_LEAN_DEG, MAX_LEAN_DEG);

        root.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${r.toFixed(2)}deg) scale(${(scaleX * size).toFixed(3)}, ${(scaleY * size).toFixed(3)})`;
        const rustle = sway * (0.5 + level * 1.5) * dancing;
        spikes.style.transform = `rotate(${rustle.toFixed(2)}deg)`;
        const faceX = gazeX.x * FACE_TRAVEL_PX;
        const faceY = (gazeY.x * FACE_TRAVEL_PX) / 3 + pose.nod * dancing;
        head.style.transform = `translate(${faceX.toFixed(2)}px, ${faceY.toFixed(2)}px) rotate(${gazeX.x.toFixed(2)}deg)`;
    }

    function hop() {
        if (holdStill) return;
        jump.v -= 190;
        squash.v += 1.4;
        swell.v += 0.4;
    }

    function boop() {
        wokenUntil = now + WAKE_MS;
        startledUntil = now + STARTLE_MS;
        squash.v -= 2.6;
        swell.v += 0.8;
        popNote();
    }

    function nudge(dx) {
        lean.v += clamp(dx, -12, 12) * 2.2;
    }

    async function loadWave(url, duration, id) {
        if (reduced || id === waveId) return;
        waveId = id;
        wave = null;
        lastIndex = -1;
        request?.abort();
        if (!url) return;
        request = new AbortController();
        try {
            const r = await fetch(url.replace(/\.png$/, ".json"), { signal: request.signal });
            const data = await r.json();
            if (id === waveId) wave = buildWave(data.samples, duration);
        } catch {
            // no waveform, pudding just dances at a steady pace
        }
    }

    function destroy() {
        request?.abort();
        window.removeEventListener("pointermove", onPointer);
    }

    return { tick, hop, boop, nudge, loadWave, destroy };
    // bippity boppity boo this pudding can now dance too
}
