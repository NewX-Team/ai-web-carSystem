/**
 * game.js
 * Modul Utama Game Simulator Mengemudi Tol Indonesia (POV Supir Kemudi Kanan - RHD).
 * Mengatur render 3D jalan raya, fisika mobil, audio sintesis, dan sinkronisasi kemudi dari Python ML.
 */

const canvas = document.getElementById('roadCanvas');
const ctx = canvas.getContext('2d');
let W = 0, H = 0;

function handleResize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
}
window.addEventListener('resize', handleResize);
handleResize();

// ─────────────────────────────────────────────────────────────────────────────
//  AUDIO SYSTEM (Web Audio API - Synthesizer Engine & Horn)
// ─────────────────────────────────────────────────────────────────────────────
let audioCtx = null;
let engineOsc = null;
let engineGain = null;
let engineNoiseGain = null;
let audioReady = false;

function initAudio() {
    if (audioReady) return;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContext();

        engineOsc = audioCtx.createOscillator();
        engineOsc.type = 'sawtooth';
        engineGain = audioCtx.createGain();
        engineGain.gain.value = 0.035;

        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 340;

        engineOsc.connect(filter);
        filter.connect(engineGain);
        engineGain.connect(audioCtx.destination);
        engineOsc.start();

        const bufferSize = audioCtx.sampleRate * 2;
        const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        const whiteNoise = audioCtx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;
        whiteNoise.loop = true;

        const noiseFilter = audioCtx.createBiquadFilter();
        noiseFilter.type = 'bandpass';
        noiseFilter.frequency.value = 520;
        noiseFilter.Q.value = 1.0;

        engineNoiseGain = audioCtx.createGain();
        engineNoiseGain.gain.value = 0.008;

        whiteNoise.connect(noiseFilter);
        noiseFilter.connect(engineNoiseGain);
        engineNoiseGain.connect(audioCtx.destination);
        whiteNoise.start();

        audioReady = true;
        const hint = document.getElementById('audio-hint');
        if (hint) {
            hint.style.opacity = '0';
            setTimeout(() => hint.remove(), 600);
        }
    } catch (e) {
        console.log('Audio init prevented:', e);
    }
}

function updateAudio(rpm, speed) {
    if (!audioReady || !audioCtx) return;
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
    const freq = 38 + (rpm / 8000) * 155;
    engineOsc.frequency.setTargetAtTime(freq, audioCtx.currentTime, 0.05);

    const vol = 0.025 + (rpm / 8000) * 0.05;
    engineGain.gain.setTargetAtTime(vol, audioCtx.currentTime, 0.05);

    const hiss = Math.min(0.05, Math.abs(speed * 3.6) / 220 * 0.05);
    engineNoiseGain.gain.setTargetAtTime(hiss, audioCtx.currentTime, 0.08);
}

function playHorn() {
    if (!audioCtx) initAudio();
    if (!audioCtx) return;
    try {
        const now = audioCtx.currentTime;
        [415, 520].forEach(f => {
            const osc = audioCtx.createOscillator();
            const g = audioCtx.createGain();
            osc.type = 'triangle';
            osc.frequency.value = f;
            g.gain.setValueAtTime(0.12, now);
            g.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc.connect(g);
            g.connect(audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.36);
        });
    } catch (err) {}
}

function playClick() {
    if (!audioCtx) return;
    try {
        const now = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1400, now);
        osc.frequency.exponentialRampToValueAtTime(400, now + 0.03);
        g.gain.setValueAtTime(0.04, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
        osc.connect(g);
        g.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.04);
    } catch (err) {}
}

// ─────────────────────────────────────────────────────────────────────────────
//  INPUT CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
const keys = {};
let hazardOn = false;

window.addEventListener('keydown', e => {
    initAudio();
    keys[e.code] = true;

    if (e.code === 'KeyH') {
        playHorn();
        showHornPopup();
    }
    if (e.code === 'KeyF') {
        hazardOn = !hazardOn;
        playClick();
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
    }
});

window.addEventListener('keyup', e => {
    keys[e.code] = false;
});

function showHornPopup() {
    const popup = document.getElementById('beep-banner');
    if (!popup) return;
    popup.classList.add('active');
    clearTimeout(popup._t);
    popup._t = setTimeout(() => {
        popup.classList.remove('active');
    }, 450);
}

const input = {
    get gas()   { return !!(keys.ArrowUp   || keys.KeyW); },
    get brake() { return !!(keys.ArrowDown || keys.KeyS); },
    get left()  { return !!(keys.ArrowLeft || keys.KeyA); },
    get right() { return !!(keys.ArrowRight|| keys.KeyD); },
    get horn()  { return !!keys.KeyH; }
};

// ─────────────────────────────────────────────────────────────────────────────
//  ROAD GEOMETRY & CURVATURE
// ─────────────────────────────────────────────────────────────────────────────
const LANE_W      = 3.8;
const LANES_COUNT = 3;
const CARRIAGE_W  = LANE_W * LANES_COUNT;
const SHOULDER_W  = 2.8;
const MEDIAN_W    = 1.6;

function getLaneCenter(i) {
    return -CARRIAGE_W / 2 + LANE_W / 2 + i * LANE_W;
}

function getRoadCurve(distanceZ) {
    const d = car.distance + distanceZ;
    return Math.sin(d * 0.0016) * 14.0 + Math.sin(d * 0.0006) * 22.0;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CAR STATE & PHYSICS
// ─────────────────────────────────────────────────────────────────────────────
const car = {
    speed: 0,
    posX: getLaneCenter(1),
    velX: 0,
    wheelAngle: 0,
    wheelTarget: 0,
    throttle: 0,
    brakePedal: 0,
    rpm: 800,
    gear: 1,
    distance: 88400,
    bodyRoll: 0,
    bodyPitch: 0,
};

const MAX_SPEED_FWD = 210 / 3.6;
const MAX_SPEED_REV = 35 / 3.6;
const ENGINE_ACCEL  = 4300;
const BRAKE_ACCEL   = 8800;
const CAR_MASS      = 1350;
const AIR_DRAG      = 0.36;
const ROLLING_RES   = 140;
const MAX_STEER_DEG = 450;

const GEAR_NAMES = ['N', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
const GEAR_UP_KMH = [0, 32, 60, 95, 135, 175, 999];
const GEAR_DN_KMH = [0, 0,  24, 48,  80, 115, 150];

function updateGearAndRPM() {
    const kmh = Math.abs(car.speed * 3.6);
    if (car.speed < -0.3) {
        car.gear = -1;
        car.rpm = 900 + (Math.abs(car.speed) / MAX_SPEED_REV) * 3500;
        return;
    }
    if (kmh < 1.5 && car.throttle < 0.05) {
        car.gear = 0;
        car.rpm = 800;
        return;
    }

    let g = Math.max(1, car.gear);
    if (g < 6 && kmh > GEAR_UP_KMH[g]) g++;
    if (g > 1 && kmh < GEAR_DN_KMH[g]) g--;
    car.gear = g;

    const minRPM = 1200;
    const maxRPM = 6200;
    const gLo = GEAR_DN_KMH[g] || 0;
    const gHi = GEAR_UP_KMH[g];
    const frac = Math.max(0, Math.min(1, (kmh - gLo) / (gHi - gLo)));
    car.rpm = minRPM + frac * (maxRPM - minRPM);

    if (car.throttle > 0.8) car.rpm = Math.min(6800, car.rpm + 400);
}

// ─────────────────────────────────────────────────────────────────────────────
//  INDONESIAN HIGHWAY SCENERY & TRAFFIC
// ─────────────────────────────────────────────────────────────────────────────
const trafficCars = [];
const INDO_CAR_COLORS = [
    '#f8fafc', '#e2e8f0', '#0f172a', '#475569', '#b91c1c', '#1d4ed8', '#15803d', '#92400e'
];
const TRUCK_COLORS = [
    '#eab308', '#f97316', '#0284c7', '#16a34a', '#dc2626'
];
const BUS_LIVERIES = [
    { base: '#1e3a8a', stripe: '#facc15', name: 'SINAR JAYA' },
    { base: '#991b1b', stripe: '#fbbf24', name: 'PAHALA KENCANA' },
    { base: '#047857', stripe: '#ffffff', name: 'PRIMAJASA' },
    { base: '#4338ca', stripe: '#38bdf8', name: 'LORENA' }
];

function spawnTraffic(initialZ) {
    const lane = Math.floor(Math.random() * 3);
    const r = Math.random();
    let type = 'car';
    let speed = (70 + Math.random() * 50) / 3.6;
    let color = INDO_CAR_COLORS[Math.floor(Math.random() * INDO_CAR_COLORS.length)];
    let busData = null;
    let plate = 'B ' + (1000 + Math.floor(Math.random() * 8999)) + ' ' +
                String.fromCharCode(65 + Math.floor(Math.random() * 26)) +
                String.fromCharCode(65 + Math.floor(Math.random() * 26));

    if (lane === 0 && r < 0.6) {
        type = 'truck';
        speed = (45 + Math.random() * 30) / 3.6;
        color = TRUCK_COLORS[Math.floor(Math.random() * TRUCK_COLORS.length)];
    } else if ((lane === 0 || lane === 1) && r > 0.75) {
        type = 'bus';
        speed = (75 + Math.random() * 35) / 3.6;
        busData = BUS_LIVERIES[Math.floor(Math.random() * BUS_LIVERIES.length)];
    }

    trafficCars.push({
        z: initialZ || (250 + Math.random() * 150),
        lane,
        posX: getLaneCenter(lane) + (Math.random() - 0.5) * 0.3,
        speed,
        type,
        color,
        busData,
        plate,
        w: type === 'truck' ? 2.6 : (type === 'bus' ? 2.7 : 1.85),
        h: type === 'truck' ? 3.4 : (type === 'bus' ? 3.6 : 1.6),
    });
}

for (let i = 0; i < 7; i++) {
    spawnTraffic(40 + i * 36 + Math.random() * 18);
}

const sceneryItems = [];
const TOLL_SIGNS = [
    { text: 'BANDUNG / PADALARANG', sub: 'LAJUR KANAN CEPAT', dist: '35 KM' },
    { text: 'REST AREA KM 88 A', sub: '⛽ SPBU • ☕ KULINER • 🕌 MASJID', dist: '1 KM' },
    { text: 'CIKAMPEK / JAKARTA', sub: 'JALAN LAYANG MBZ', dist: '500 M' },
    { text: 'GERBANG TOL PASTEUR', sub: 'SIAPKAN SALDO E-TOLL', dist: '2 KM' },
    { text: 'PURWAKARTA / JATILUHUR', sub: 'KELUAR TOL', dist: '1 KM' }
];

function spawnScenery(initialZ) {
    const side = Math.random() < 0.6 ? -1 : 1;
    const z = initialZ || (280 + Math.random() * 80);
    const rand = Math.random();
    let type = 'tree';

    if (rand < 0.38) {
        type = 'tree';
    } else if (rand < 0.58) {
        type = 'palm';
    } else if (rand < 0.75) {
        type = 'pju_lamp';
    } else if (rand < 0.88) {
        type = 'speed_sign';
    } else {
        type = 'gantry_toll';
    }

    const signData = (type === 'gantry_toll')
        ? TOLL_SIGNS[Math.floor(Math.random() * TOLL_SIGNS.length)]
        : null;

    sceneryItems.push({
        type,
        side,
        z,
        signData,
        xOffset: side === -1 ? (-CARRIAGE_W / 2 - SHOULDER_W - 2.5 - Math.random() * 7)
                            : (CARRIAGE_W / 2 + MEDIAN_W + 3.0 + Math.random() * 7)
    });
}

for (let i = 0; i < 28; i++) {
    spawnScenery(15 + i * 11 + Math.random() * 8);
}

const hills = [];
for (let i = 0; i < 40; i++) {
    hills.push({
        x: (i / 40) * 2.5 - 0.75,
        h: 0.05 + Math.random() * 0.14,
        w: 0.04 + Math.random() * 0.08,
        color: `hsl(${145 + Math.random() * 35}, ${22 + Math.random() * 15}%, ${14 + Math.random() * 15}%)`
    });
}

const clouds = [];
for (let i = 0; i < 10; i++) {
    clouds.push({
        x: Math.random() * 2 - 0.5,
        y: 0.04 + Math.random() * 0.12,
        w: 40 + Math.random() * 70,
        h: 12 + Math.random() * 20,
        speed: 0.000015 + Math.random() * 0.000025
    });
}

// ─────────────────────────────────────────────────────────────────────────────
//  3D PROJECTION & DRIVER'S POV (Kemudi Kanan / RHD)
// ─────────────────────────────────────────────────────────────────────────────
const DRIVER_EYE_OFFSET_X = 0.48;
const CAM_EYE_HEIGHT      = 1.18;
const VP_HORIZON_Y        = 0.36;

function worldToScreen(worldX, worldZ) {
    if (worldZ < 0.4) worldZ = 0.4;
    const fov = W * 0.88;

    const curveOffset = getRoadCurve(worldZ) - getRoadCurve(0);
    const actualWorldX = worldX + curveOffset;

    const driverWorldX = car.posX + DRIVER_EYE_OFFSET_X;
    const relX = actualWorldX - driverWorldX;

    const pitchOffset = car.bodyPitch * H * 0.12;
    const screenX = W / 2 + (relX / worldZ) * fov;
    const screenY = H * VP_HORIZON_Y + (CAM_EYE_HEIGHT / worldZ) * fov + pitchOffset;
    const scale = fov / worldZ;

    return { x: screenX, y: screenY, s: scale };
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN UPDATE LOOP
// ─────────────────────────────────────────────────────────────────────────────
let lastTime = performance.now();

function updatePhysics(dt) {
    dt = Math.min(dt, 0.04);

    const targetGas   = input.gas ? 1.0 : 0.0;
    const targetBrake = input.brake ? 1.0 : 0.0;
    car.throttle   += (targetGas - car.throttle) * 7.5 * dt;
    car.brakePedal += (targetBrake - car.brakePedal) * 11.0 * dt;

    const absSpeed = Math.abs(car.speed);

    let driveForce = 0;
    if (car.throttle > 0.02) {
        if (car.speed >= 0) {
            const powerCurve = Math.max(0, 1 - Math.pow(absSpeed / MAX_SPEED_FWD, 1.4));
            driveForce = ENGINE_ACCEL * car.throttle * powerCurve;
        } else {
            driveForce = BRAKE_ACCEL * 0.6 * car.throttle;
        }
    }

    let brakeForce = 0;
    if (car.brakePedal > 0.02) {
        if (car.speed > 0.3) {
            brakeForce = -BRAKE_ACCEL * car.brakePedal;
        } else if (car.speed > -0.1 && car.speed <= 0.3) {
            car.speed = 0;
            if (car.brakePedal > 0.25) {
                driveForce = -ENGINE_ACCEL * 0.3 * car.brakePedal;
            }
        } else {
            const revCurve = Math.max(0, 1 - Math.pow(absSpeed / MAX_SPEED_REV, 2));
            driveForce = -ENGINE_ACCEL * 0.35 * car.brakePedal * revCurve;
        }
    }

    const dragForce = -AIR_DRAG * car.speed * absSpeed;
    const rollForce = absSpeed > 0.08 ? -Math.sign(car.speed) * ROLLING_RES : 0;

    const netForce = driveForce + brakeForce + dragForce + rollForce;
    const accel = netForce / CAR_MASS;
    car.speed += accel * dt;

    if (absSpeed < 0.12 && car.throttle < 0.03 && car.brakePedal < 0.03) {
        car.speed *= 0.85;
        if (absSpeed < 0.015) car.speed = 0;
    }
    car.speed = Math.max(-MAX_SPEED_REV, Math.min(MAX_SPEED_FWD, car.speed));

    // ── Steering Input: Python ML Head Tracking (Jika Aktif) + Keyboard ──
    let steerDir = 0;

    // Ambil nilai kemudi dari modul Python ML TrackerClient
    if (window.TrackerClient && TrackerClient.active && Math.abs(TrackerClient.steerValue) > 0.01) {
        steerDir = TrackerClient.steerValue;
    }

    // Keyboard dapat meng-override atau membantu kemudi
    if (input.left)  steerDir = -1.0;
    if (input.right) steerDir =  1.0;

    car.wheelTarget = steerDir * MAX_STEER_DEG;
    const returnSpeed = (steerDir === 0) ? 9.5 : 8.0;
    car.wheelAngle += (car.wheelTarget - car.wheelAngle) * returnSpeed * dt;
    if (Math.abs(car.wheelAngle) < 0.8 && steerDir === 0) car.wheelAngle = 0;

    const roadWheelRad = (car.wheelAngle / MAX_STEER_DEG) * 32 * (Math.PI / 180);
    if (absSpeed > 0.4) {
        const latAccel = Math.tan(roadWheelRad) * (car.speed * car.speed) / 2.7;
        const clampedLat = Math.max(-8.5, Math.min(8.5, latAccel));
        car.velX += clampedLat * dt;
    }
    car.velX -= car.velX * 4.2 * dt;
    car.posX += car.velX * dt;

    const minX = -CARRIAGE_W / 2 - SHOULDER_W + 0.8;
    const maxX =  CARRIAGE_W / 2 + 0.3;
    if (car.posX < minX) { car.posX = minX; car.velX = Math.max(0, car.velX * -0.2); }
    if (car.posX > maxX) { car.posX = maxX; car.velX = Math.min(0, car.velX * -0.2); }

    const targetPitch = (accel / 15) * 0.04;
    car.bodyPitch += (targetPitch - car.bodyPitch) * 8 * dt;

    const targetRoll = (car.velX / 5) * 0.03;
    car.bodyRoll += (targetRoll - car.bodyRoll) * 6 * dt;

    car.distance += car.speed * dt;

    updateGearAndRPM();
    updateAudio(car.rpm, car.speed);

    for (let i = trafficCars.length - 1; i >= 0; i--) {
        const tc = trafficCars[i];
        tc.z -= (car.speed - tc.speed) * dt;
        if (tc.z < -25 || tc.z > 420) {
            trafficCars.splice(i, 1);
        }
    }
    if (trafficCars.length < 8 && Math.random() < 0.03) {
        spawnTraffic();
    }

    for (let i = sceneryItems.length - 1; i >= 0; i--) {
        const sc = sceneryItems[i];
        sc.z -= car.speed * dt;
        if (sc.z < -10) {
            sceneryItems.splice(i, 1);
        }
    }
    if (sceneryItems.length < 30 && Math.random() < 0.09) {
        spawnScenery();
    }

    for (const c of clouds) {
        c.x += c.speed;
        if (c.x > 1.6) c.x = -0.6;
    }

    const speedKmh = Math.abs(Math.round(car.speed * 3.6));
    document.getElementById('hud-speed').textContent = speedKmh;
    document.getElementById('hud-rpm').textContent   = Math.round(car.rpm);

    const kmMarker = (car.distance / 1000).toFixed(1);
    document.getElementById('hud-route').textContent = `Tol Cipularang KM ${kmMarker}`;

    let gText = 'D';
    if (car.gear === -1) gText = 'R';
    else if (car.gear === 0) gText = 'N';
    else gText = GEAR_NAMES[car.gear] || 'D';
    document.getElementById('hud-gear').textContent = gText;
}

// ─────────────────────────────────────────────────────────────────────────────
//  RENDERING PIPELINE
// ─────────────────────────────────────────────────────────────────────────────
function renderFrame() {
    ctx.clearRect(0, 0, W, H);
    const horizonY = H * VP_HORIZON_Y + car.bodyPitch * H * 0.12;

    renderSkyAndMountains(horizonY);
    renderGrassLandscape(horizonY);
    renderSmoothHighway(horizonY);
    render3DWorldObjects();
    renderCockpitRHD();
}

// ── 1. Sky & Tropical Mountains ──
function renderSkyAndMountains(hy) {
    const skyGrad = ctx.createLinearGradient(0, 0, 0, hy + 30);
    skyGrad.addColorStop(0, '#0369a1');
    skyGrad.addColorStop(0.35, '#38bdf8');
    skyGrad.addColorStop(0.7, '#7dd3fc');
    skyGrad.addColorStop(1, '#bae6fd');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, hy + 30);

    const sunX = W * 0.76;
    const sunY = H * 0.11;
    const sG = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 110);
    sG.addColorStop(0, 'rgba(255, 255, 240, 0.95)');
    sG.addColorStop(0.2, 'rgba(254, 240, 138, 0.45)');
    sG.addColorStop(0.6, 'rgba(254, 240, 138, 0.1)');
    sG.addColorStop(1, 'transparent');
    ctx.fillStyle = sG;
    ctx.fillRect(sunX - 110, sunY - 110, 220, 220);

    ctx.beginPath();
    ctx.arc(sunX, sunY, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    for (const c of clouds) {
        const cx = c.x * W;
        const cy = c.y * H;
        ctx.beginPath();
        ctx.ellipse(cx, cy, c.w, c.h, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(cx - c.w * 0.38, cy + c.h * 0.25, c.w * 0.6, c.h * 0.75, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(cx + c.w * 0.35, cy + c.h * 0.18, c.w * 0.55, c.h * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    for (const m of hills) {
        const mx = m.x * W;
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.moveTo(mx - m.w * W, hy + 2);
        ctx.lineTo(mx, hy - m.h * H);
        ctx.lineTo(mx + m.w * W, hy + 2);
        ctx.closePath();
        ctx.fill();
    }
}

// ── 2. Tropical Grass Field ──
function renderGrassLandscape(hy) {
    const gGrad = ctx.createLinearGradient(0, hy, 0, H);
    gGrad.addColorStop(0, '#15803d');
    gGrad.addColorStop(0.25, '#16a34a');
    gGrad.addColorStop(0.6, '#15803d');
    gGrad.addColorStop(1, '#14532d');
    ctx.fillStyle = gGrad;
    ctx.fillRect(0, hy, W, H - hy);
}

// ── 3. Smooth Highway Rendering ──
function renderSmoothHighway(hy) {
    const maxZ = 240;
    const steps = 70;

    for (let i = 0; i < steps; i++) {
        const z1 = 2.5 + (i / steps) * maxZ;
        const z2 = 2.5 + ((i + 1) / steps) * maxZ;

        const shL1 = worldToScreen(-CARRIAGE_W / 2 - SHOULDER_W, z1);
        const shR1 = worldToScreen(-CARRIAGE_W / 2, z1);
        const shL2 = worldToScreen(-CARRIAGE_W / 2 - SHOULDER_W, z2);
        const shR2 = worldToScreen(-CARRIAGE_W / 2, z2);

        if (shL1.y < hy - 3 && shL2.y < hy - 3) continue;

        ctx.fillStyle = '#475569';
        ctx.beginPath();
        ctx.moveTo(shL1.x, shL1.y); ctx.lineTo(shR1.x, shR1.y);
        ctx.lineTo(shR2.x, shR2.y); ctx.lineTo(shL2.x, shL2.y);
        ctx.closePath(); ctx.fill();

        const rL1 = worldToScreen(-CARRIAGE_W / 2, z1);
        const rR1 = worldToScreen( CARRIAGE_W / 2, z1);
        const rL2 = worldToScreen(-CARRIAGE_W / 2, z2);
        const rR2 = worldToScreen( CARRIAGE_W / 2, z2);

        const fog = Math.min(1, i / steps);
        const rCol = Math.floor(34 * (1 - fog) + 75 * fog);
        const gCol = Math.floor(38 * (1 - fog) + 85 * fog);
        const bCol = Math.floor(46 * (1 - fog) + 105 * fog);

        ctx.fillStyle = `rgb(${rCol}, ${gCol}, ${bCol})`;
        ctx.beginPath();
        ctx.moveTo(rL1.x, rL1.y); ctx.lineTo(rR1.x, rR1.y);
        ctx.lineTo(rR2.x, rR2.y); ctx.lineTo(rL2.x, rL2.y);
        ctx.closePath(); ctx.fill();

        const medL1 = worldToScreen(CARRIAGE_W / 2, z1);
        const medR1 = worldToScreen(CARRIAGE_W / 2 + MEDIAN_W, z1);
        const medL2 = worldToScreen(CARRIAGE_W / 2, z2);
        const medR2 = worldToScreen(CARRIAGE_W / 2 + MEDIAN_W, z2);

        ctx.fillStyle = (Math.floor((car.distance + z1) / 4) % 2 === 0) ? '#d97706' : '#1e293b';
        ctx.beginPath();
        ctx.moveTo(medL1.x, medL1.y); ctx.lineTo(medR1.x, medR1.y);
        ctx.lineTo(medR2.x, medR2.y); ctx.lineTo(medL2.x, medL2.y);
        ctx.closePath(); ctx.fill();
    }

    renderSmoothLaneMarkings(maxZ);
    renderConcreteBarrier(maxZ);
}

function renderSmoothLaneMarkings(maxZ) {
    renderContinuousSolidLine(-CARRIAGE_W / 2, maxZ, 'rgba(238, 242, 246, 0.85)', 0.15);
    renderContinuousSolidLine(CARRIAGE_W / 2, maxZ, 'rgba(250, 204, 21, 0.9)', 0.15);

    renderContinuousDashedLine(-CARRIAGE_W / 2 + LANE_W, maxZ, 5.0, 9.0);
    renderContinuousDashedLine(-CARRIAGE_W / 2 + LANE_W * 2, maxZ, 5.0, 9.0);
}

function renderContinuousSolidLine(worldX, maxZ, color, realWidthMeters) {
    const segSteps = 50;
    ctx.strokeStyle = color;

    for (let i = 0; i < segSteps; i++) {
        const z1 = 2.5 + (i / segSteps) * maxZ;
        const z2 = 2.5 + ((i + 1) / segSteps) * maxZ;

        const p1 = worldToScreen(worldX, z1);
        const p2 = worldToScreen(worldX, z2);

        const distFade = Math.max(0, Math.min(1, 1 - (z1 - 30) / (maxZ - 30)));
        const nearFade = Math.max(0, Math.min(1, (z1 - 2.5) / 1.5));
        const alpha = 0.85 * distFade * nearFade;

        ctx.globalAlpha = alpha;
        ctx.lineWidth = Math.max(0.8, Math.min(7.5, realWidthMeters * p1.s));
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
    }
    ctx.globalAlpha = 1.0;
}

function renderContinuousDashedLine(worldX, maxZ, dashLen, gapLen) {
    const cycle = dashLen + gapLen;

    const firstIdx = Math.floor((car.distance + 2.5) / cycle);
    const lastIdx  = Math.ceil((car.distance + maxZ) / cycle);

    for (let k = firstIdx; k <= lastIdx; k++) {
        const stripeStartDist = k * cycle;
        const z1 = stripeStartDist - car.distance;
        const z2 = z1 + dashLen;

        if (z2 < 2.5 || z1 > maxZ) continue;

        const clampedZ1 = Math.max(2.5, z1);
        const clampedZ2 = Math.min(maxZ, z2);

        const p1 = worldToScreen(worldX, clampedZ1);
        const p2 = worldToScreen(worldX, clampedZ2);

        const distFade = Math.max(0, Math.min(1, 1 - (clampedZ1 - 35) / (maxZ - 35)));
        const nearFade = Math.max(0, Math.min(1, (clampedZ1 - 2.5) / 1.5));
        const alpha = 0.8 * distFade * nearFade;

        ctx.strokeStyle = `rgba(240, 244, 248, ${alpha})`;
        ctx.lineWidth = Math.max(0.8, Math.min(6.5, 0.14 * p1.s));
        ctx.lineCap = 'butt';

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
    }
}

function renderConcreteBarrier(maxZ) {
    const barX = CARRIAGE_W / 2 + 0.15;
    for (let z = 3; z < maxZ; z += 4.5) {
        const pBase  = worldToScreen(barX, z);
        const pTop   = worldToScreen(barX, z);
        pTop.y -= Math.max(1, 0.8 * pBase.s);

        const pBase2 = worldToScreen(barX, z + 4.5);
        const pTop2  = worldToScreen(barX, z + 4.5);
        pTop2.y -= Math.max(1, 0.8 * pBase2.s);

        if (pBase.s < 0.25) continue;

        ctx.fillStyle = '#94a3b8';
        ctx.beginPath();
        ctx.moveTo(pBase.x, pBase.y);
        ctx.lineTo(pTop.x, pTop.y);
        ctx.lineTo(pTop2.x, pTop2.y);
        ctx.lineTo(pBase2.x, pBase2.y);
        ctx.closePath();
        ctx.fill();

        if (Math.floor(z / 9) % 2 === 0) {
            ctx.fillStyle = '#ef4444';
            const rW = Math.max(2, 4 * pBase.s * 0.05);
            const rH = Math.max(1, 3 * pBase.s * 0.05);
            ctx.fillRect(pTop.x - 1, pTop.y + (pBase.y - pTop.y) * 0.35, rW, rH);
        }
    }
}

// ── 4. 3D World Objects ──
function render3DWorldObjects() {
    const items = [];
    for (const t of trafficCars) {
        if (t.z > 1.2) items.push({ z: t.z, draw: () => renderTrafficCar3D(t) });
    }
    for (const s of sceneryItems) {
        if (s.z > 1.2) items.push({ z: s.z, draw: () => renderSceneryItem3D(s) });
    }
    items.sort((a, b) => b.z - a.z);
    for (const item of items) {
        item.draw();
    }
}

function renderTrafficCar3D(t) {
    const p = worldToScreen(t.posX, t.z);
    if (p.x < -120 || p.x > W + 120) return;
    const sc = p.s * 0.085;
    if (sc < 0.25) return;

    const cw = t.w * sc * 11.5;
    const ch = t.h * sc * 11.5;
    const cx = p.x;
    const cy = p.y;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 2, cw * 0.62, ch * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    if (t.type === 'truck') {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(cx - cw * 0.48, cy - ch * 0.25, cw * 0.96, ch * 0.22);

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(cx - cw * 0.52, cy - ch * 0.18, cw * 0.15, ch * 0.18);
        ctx.fillRect(cx + cw * 0.37, cy - ch * 0.18, cw * 0.15, ch * 0.18);

        ctx.fillStyle = t.color;
        ctx.fillRect(cx - cw / 2, cy - ch, cw, ch * 0.78);

        ctx.fillStyle = '#1e3a8a';
        ctx.beginPath();
        ctx.moveTo(cx - cw / 2, cy - ch);
        ctx.lineTo(cx, cy - ch * 1.22);
        ctx.lineTo(cx + cw / 2, cy - ch);
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = '#f8fafc';
        ctx.font = `bold ${Math.max(5, 7.5 * sc)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('DOA IBU', cx, cy - ch * 0.65);

        ctx.fillStyle = '#dc2626';
        ctx.fillRect(cx - cw * 0.45, cy - ch * 0.2, cw * 0.2, ch * 0.07);
        ctx.fillRect(cx + cw * 0.25, cy - ch * 0.2, cw * 0.2, ch * 0.07);

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(cx - cw * 0.16, cy - ch * 0.15, cw * 0.32, ch * 0.08);
        ctx.fillStyle = '#ffffff';
        ctx.font = `${Math.max(4, 5 * sc)}px monospace`;
        ctx.fillText(t.plate, cx, cy - ch * 0.09);

    } else if (t.type === 'bus') {
        const bus = t.busData;
        ctx.fillStyle = bus.base;
        drawRoundedRect(ctx, cx - cw / 2, cy - ch, cw, ch, 4 * sc);
        ctx.fill();

        ctx.fillStyle = bus.stripe;
        ctx.fillRect(cx - cw / 2, cy - ch * 0.55, cw, ch * 0.12);

        ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
        drawRoundedRect(ctx, cx - cw * 0.42, cy - ch * 0.92, cw * 0.84, ch * 0.32, 2 * sc);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = `900 ${Math.max(5, 7 * sc)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(bus.name, cx, cy - ch * 0.95);

        ctx.fillStyle = '#ef4444';
        ctx.fillRect(cx - cw * 0.45, cy - ch * 0.18, cw * 0.14, ch * 0.08);
        ctx.fillRect(cx + cw * 0.31, cy - ch * 0.18, cw * 0.14, ch * 0.08);

        ctx.fillStyle = '#0f172a';
        ctx.fillRect(cx - cw * 0.15, cy - ch * 0.12, cw * 0.3, ch * 0.06);
        ctx.fillStyle = '#fff';
        ctx.font = `${Math.max(4, 4.5 * sc)}px monospace`;
        ctx.fillText(t.plate, cx, cy - ch * 0.07);

    } else {
        ctx.fillStyle = t.color;
        drawRoundedRect(ctx, cx - cw / 2, cy - ch, cw, ch, 3.5 * sc);
        ctx.fill();

        ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
        drawRoundedRect(ctx, cx - cw * 0.38, cy - ch * 0.85, cw * 0.76, ch * 0.35, 2 * sc);
        ctx.fill();

        ctx.fillStyle = 'rgba(14, 116, 144, 0.5)';
        drawRoundedRect(ctx, cx - cw * 0.36, cy - ch * 0.78, cw * 0.72, ch * 0.22, 2 * sc);
        ctx.fill();

        ctx.fillStyle = '#dc2626';
        ctx.fillRect(cx - cw * 0.48, cy - ch * 0.45, cw * 0.2, ch * 0.12);
        ctx.fillRect(cx + cw * 0.28, cy - ch * 0.45, cw * 0.2, ch * 0.12);

        ctx.fillStyle = '#1e293b';
        ctx.fillRect(cx - cw * 0.18, cy - ch * 0.22, cw * 0.36, ch * 0.08);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.max(4, 5 * sc)}px monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(t.plate, cx, cy - ch * 0.15);
    }
}

function renderSceneryItem3D(s) {
    const p = worldToScreen(s.xOffset, s.z);
    if (p.x < -140 || p.x > W + 140) return;
    const sc = Math.max(0.1, p.s * 0.085);
    if (sc < 0.2) return;

    switch (s.type) {
        case 'gantry_toll': {
            const pCenter = worldToScreen(0, s.z);
            const gw = CARRIAGE_W * 1.25 * pCenter.s * 0.85;
            const gh = 38 * sc;
            const gy = pCenter.y - 120 * sc;

            ctx.fillStyle = '#64748b';
            ctx.fillRect(pCenter.x - gw / 2 - 4 * sc, gy, 8 * sc, pCenter.y - gy);
            ctx.fillRect(pCenter.x + gw / 2 - 4 * sc, gy, 8 * sc, pCenter.y - gy);

            ctx.fillStyle = '#15803d';
            drawRoundedRect(ctx, pCenter.x - gw / 2, gy - gh, gw, gh, 4 * sc);
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(1, 2 * sc);
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.font = `bold ${Math.max(6, 10 * sc)}px sans-serif`;
            ctx.fillText(s.signData.text, pCenter.x, gy - gh * 0.58);

            ctx.fillStyle = '#fef08a';
            ctx.font = `bold ${Math.max(5, 7 * sc)}px sans-serif`;
            ctx.fillText(s.signData.sub + ' • ' + s.signData.dist, pCenter.x, gy - gh * 0.22);
            break;
        }

        case 'speed_sign': {
            const h = 55 * sc;
            ctx.fillStyle = '#6b7280';
            ctx.fillRect(p.x - 1.5 * sc, p.y - h, 3 * sc, h);

            const r = 14 * sc;
            ctx.beginPath();
            ctx.arc(p.x, p.y - h, r, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.strokeStyle = '#dc2626';
            ctx.lineWidth = 3.5 * sc;
            ctx.stroke();

            ctx.fillStyle = '#0f172a';
            ctx.font = `900 ${Math.max(6, 10 * sc)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('100', p.x, p.y - h);
            break;
        }

        case 'pju_lamp': {
            const h = 100 * sc;
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = Math.max(1.2, 3 * sc);
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x, p.y - h);
            const armDir = s.side === -1 ? 1 : -1;
            ctx.quadraticCurveTo(p.x, p.y - h - 10 * sc, p.x + 22 * sc * armDir, p.y - h - 5 * sc);
            ctx.stroke();

            ctx.fillStyle = '#fef08a';
            ctx.beginPath();
            ctx.arc(p.x + 22 * sc * armDir, p.y - h - 3 * sc, 3.5 * sc, 0, Math.PI * 2);
            ctx.fill();
            break;
        }

        case 'palm': {
            const h = 95 * sc;
            ctx.strokeStyle = '#78350f';
            ctx.lineWidth = Math.max(2, 6 * sc);
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.quadraticCurveTo(p.x + 8 * sc, p.y - h * 0.5, p.x + 4 * sc, p.y - h);
            ctx.stroke();

            ctx.fillStyle = '#15803d';
            for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
                ctx.beginPath();
                ctx.ellipse(p.x + 4 * sc + Math.cos(a) * 18 * sc,
                            p.y - h + Math.sin(a) * 12 * sc,
                            20 * sc, 6 * sc, a, 0, Math.PI * 2);
                ctx.fill();
            }
            break;
        }

        case 'tree':
        default: {
            const h = 85 * sc;
            ctx.fillStyle = '#451a03';
            ctx.fillRect(p.x - 3.5 * sc, p.y - h * 0.5, 7 * sc, h * 0.5);

            ctx.fillStyle = '#166534';
            ctx.beginPath();
            ctx.ellipse(p.x, p.y - h * 0.6, 26 * sc, 22 * sc, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = '#15803d';
            ctx.beginPath();
            ctx.ellipse(p.x - 6 * sc, p.y - h * 0.72, 20 * sc, 18 * sc, 0, 0, Math.PI * 2);
            ctx.fill();
            break;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  5. COCKPIT INTERIOR (RHD INDONESIA)
// ─────────────────────────────────────────────────────────────────────────────
function renderCockpitRHD() {
    const dashHeight = H * 0.28;
    const dashTopY   = H - dashHeight;

    // 5.1 Clean Metallic Car Hood (Kap Mesin)
    const hoodGrad = ctx.createLinearGradient(0, dashTopY + 10, 0, H);
    hoodGrad.addColorStop(0, '#334155');
    hoodGrad.addColorStop(0.3, '#1e293b');
    hoodGrad.addColorStop(1, '#0f172a');
    ctx.fillStyle = hoodGrad;

    ctx.beginPath();
    ctx.moveTo(W * 0.05, dashTopY + 28);
    ctx.quadraticCurveTo(W * 0.5, dashTopY + 8, W * 0.95, dashTopY + 28);
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W * 0.28, dashTopY + 22);
    ctx.lineTo(W * 0.18, H);
    ctx.moveTo(W * 0.72, dashTopY + 22);
    ctx.lineTo(W * 0.82, H);
    ctx.stroke();

    // 5.2 Dashboard Body
    const dGrad = ctx.createLinearGradient(0, dashTopY, 0, H);
    dGrad.addColorStop(0, '#0f172a');
    dGrad.addColorStop(0.2, '#1e293b');
    dGrad.addColorStop(0.6, '#0f172a');
    dGrad.addColorStop(1, '#020617');
    ctx.fillStyle = dGrad;

    ctx.beginPath();
    ctx.moveTo(0, dashTopY + 34);
    ctx.quadraticCurveTo(W * 0.22, dashTopY + 24, W * 0.42, dashTopY + 18);
    ctx.lineTo(W * 0.56, dashTopY + 18);
    ctx.quadraticCurveTo(W * 0.72, dashTopY - 20, W * 0.88, dashTopY + 14);
    ctx.lineTo(W, dashTopY + 34);
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(234, 179, 8, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(W * 0.05, dashTopY + 38);
    ctx.lineTo(W * 0.45, dashTopY + 26);
    ctx.moveTo(W * 0.55, dashTopY + 26);
    ctx.lineTo(W * 0.95, dashTopY + 38);
    ctx.stroke();
    ctx.setLineDash([]);

    renderWindshieldFrame(dashTopY);
    renderWipers(dashTopY);
    renderCenterInfotainment(W * 0.43, dashTopY + 16, W * 0.14, dashHeight * 0.65);
    renderMirrors();

    // Instrument Cluster on Right (X = W * 0.73)
    const clusterCenterX = W * 0.73;
    const clusterCenterY = dashTopY + dashHeight * 0.32;
    const clusterRadius  = Math.min(W, H) * 0.07;
    renderInstrumentCluster(clusterCenterX, clusterCenterY, clusterRadius);

    // Steering Wheel on Right
    const wheelCenterX = W * 0.73;
    const wheelCenterY = H - dashHeight * 0.22;
    const wheelRadius  = Math.min(W, H) * 0.125;
    renderSteeringWheelRHD(wheelCenterX, wheelCenterY, wheelRadius, car.wheelAngle);
}

function renderWindshieldFrame(dashTopY) {
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(W * 0.045, 0);
    ctx.lineTo(W * 0.08, dashTopY + 34);
    ctx.lineTo(0, dashTopY + 34);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(W, 0);
    ctx.lineTo(W * 0.95, 0);
    ctx.lineTo(W * 0.92, dashTopY + 34);
    ctx.lineTo(W, dashTopY + 34);
    ctx.closePath();
    ctx.fill();

    const topGrad = ctx.createLinearGradient(0, 0, 0, H * 0.07);
    topGrad.addColorStop(0, 'rgba(15, 23, 42, 0.75)');
    topGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = topGrad;
    ctx.fillRect(0, 0, W, H * 0.07);

    const visorW = W * 0.26;
    const visorH = H * 0.042;
    ctx.fillStyle = '#1e293b';
    drawRoundedRect(ctx, W * 0.64, 0, visorW, visorH, 4);
    ctx.fill();

    ctx.fillStyle = '#0284c7';
    ctx.fillRect(W * 0.74, visorH - 10, 42, 10);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 7px sans-serif';
    ctx.fillText('e-toll', W * 0.75, visorH - 2);
}

function renderWipers(dashTopY) {
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(W * 0.15, dashTopY + 12);
    ctx.lineTo(W * 0.44, dashTopY + 18);
    ctx.moveTo(W * 0.52, dashTopY + 12);
    ctx.lineTo(W * 0.84, dashTopY + 18);
    ctx.stroke();
}

function renderCenterInfotainment(x, y, w, h) {
    ctx.fillStyle = '#0f172a';
    drawRoundedRect(ctx, x, y, w, h, 6);
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.stroke();

    const pad = 4;
    ctx.fillStyle = '#090d16';
    ctx.fillRect(x + pad, y + pad, w - pad * 2, h - pad * 2);

    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.5, y + h - 10);
    ctx.quadraticCurveTo(x + w * 0.52, y + h * 0.45, x + w * 0.68, y + 14);
    ctx.stroke();

    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(x + w * 0.5, y + h - 14, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('📍 Tol Cipularang', x + pad + 4, y + 15);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '8px sans-serif';
    ctx.fillText('Bandung: 34 km', x + pad + 4, y + 26);

    const isTrackerActive = window.TrackerClient && TrackerClient.active;
    const dmsStateText = isTrackerActive ? '🤖 ML DMS: AKTIF' : '🤖 ML DMS: MATI';
    ctx.fillStyle = isTrackerActive ? '#22c55e' : '#64748b';
    ctx.font = 'bold 7.5px monospace';
    ctx.fillText(dmsStateText, x + pad + 4, y + 37);

    ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
    ctx.fillRect(x + pad, y + h - 18, w - pad * 2, 14);
    ctx.fillStyle = '#facc15';
    ctx.font = '7.5px sans-serif';
    ctx.fillText('🎵 Indo Hits • Radio Gen FM', x + pad + 4, y + h - 8);

    const hzX = x + w / 2;
    const hzY = y + h + 14;
    const isHazardBlink = hazardOn && (Math.floor(Date.now() / 400) % 2 === 0);
    ctx.fillStyle = isHazardBlink ? '#ef4444' : '#7f1d1d';
    ctx.beginPath();
    ctx.moveTo(hzX, hzY - 8);
    ctx.lineTo(hzX + 9, hzY + 6);
    ctx.lineTo(hzX - 9, hzY + 6);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1.5;
    for (let l = 0; l < 3; l++) {
        ctx.beginPath();
        ctx.moveTo(x + 4, y + h + 28 + l * 4);
        ctx.lineTo(x + w - 4, y + h + 28 + l * 4);
        ctx.stroke();
    }
}

function renderMirrors() {
    drawMirrorBox(W * 0.93, H * 0.32, W * 0.065, H * 0.055, true);
    drawMirrorBox(W * 0.04, H * 0.32, W * 0.065, H * 0.055, false);

    const cmw = W * 0.14;
    const cmh = H * 0.045;
    const cmx = W * 0.44;
    const cmy = H * 0.035;

    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cmx + cmw / 2, 0);
    ctx.lineTo(cmx + cmw / 2, cmy + cmh / 2);
    ctx.stroke();

    ctx.fillStyle = '#0f172a';
    drawRoundedRect(ctx, cmx - 3, cmy - 3, cmw + 6, cmh + 6, 6);
    ctx.fill();

    const rg = ctx.createLinearGradient(cmx, cmy, cmx, cmy + cmh);
    rg.addColorStop(0, '#38bdf8');
    rg.addColorStop(0.5, '#1e293b');
    rg.addColorStop(1, '#0f172a');
    ctx.fillStyle = rg;
    ctx.fillRect(cmx, cmy, cmw, cmh);

    ctx.fillStyle = '#475569';
    ctx.beginPath();
    ctx.moveTo(cmx + cmw * 0.3, cmy + cmh);
    ctx.lineTo(cmx + cmw * 0.5, cmy + cmh * 0.4);
    ctx.lineTo(cmx + cmw * 0.7, cmy + cmh);
    ctx.closePath();
    ctx.fill();
}

function drawMirrorBox(x, y, w, h, isRight) {
    ctx.fillStyle = '#0f172a';
    drawRoundedRect(ctx, x - 2, y - 2, w + 4, h + 4, 5);
    ctx.fill();

    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, '#0284c7');
    g.addColorStop(0.4, '#15803d');
    g.addColorStop(1, '#334155');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    if (isRight) {
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + w * 0.6, y + h * 0.45);
        ctx.lineTo(x + w, y + h);
    } else {
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + w * 0.4, y + h * 0.45);
        ctx.lineTo(x + w, y + h);
    }
    ctx.closePath();
    ctx.fill();
}

function renderInstrumentCluster(cx, cy, r) {
    ctx.fillStyle = '#0b0f19';
    drawRoundedRect(ctx, cx - r * 1.9, cy - r * 0.85, r * 3.8, r * 1.7, r * 0.4);
    ctx.fill();
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 2;
    ctx.stroke();

    drawAnalogDial(cx + r * 0.9, cy, r * 0.7, Math.abs(car.speed * 3.6), 0, 220, 'km/j', '#38bdf8');
    drawAnalogDial(cx - r * 0.9, cy, r * 0.7, car.rpm, 0, 8000, 'RPM ×1000', '#22c55e');

    const midW = r * 0.95;
    const midH = r * 1.0;
    const midX = cx - midW / 2;
    const midY = cy - midH / 2;

    ctx.fillStyle = '#030712';
    drawRoundedRect(ctx, midX, midY, midW, midH, 4);
    ctx.fill();

    const gNames = ['N', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6'];
    const gStr = car.gear === -1 ? 'R' : (gNames[car.gear] || 'D');
    ctx.font = `900 ${Math.max(14, r * 0.45)}px 'Courier New', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = car.gear === -1 ? '#ef4444' : '#f59e0b';
    ctx.fillText(gStr, cx, cy - r * 0.12);

    ctx.font = `bold ${Math.max(11, r * 0.32)}px sans-serif`;
    ctx.fillStyle = '#38bdf8';
    ctx.fillText(`${Math.abs(Math.round(car.speed * 3.6))} km/j`, cx, cy + r * 0.22);

    const isBlink = Math.floor(Date.now() / 320) % 2 === 0;
    const isHeadTurnLeft  = window.TrackerClient && TrackerClient.active && (TrackerClient.steerValue < -0.15);
    const isHeadTurnRight = window.TrackerClient && TrackerClient.active && (TrackerClient.steerValue > 0.15);

    if ((input.left || isHeadTurnLeft || hazardOn) && isBlink) {
        drawTurnArrow(cx - r * 0.5, cy - r * 0.52, 7, true);
    }
    if ((input.right || isHeadTurnRight || hazardOn) && isBlink) {
        drawTurnArrow(cx + r * 0.5, cy - r * 0.52, 7, false);
    }
}

function drawAnalogDial(cx, cy, r, val, min, max, unit, col) {
    const startA = Math.PI * 0.78;
    const endA   = Math.PI * 2.22;
    const rng    = endA - startA;
    const frac   = Math.max(0, Math.min(1, (val - min) / (max - min)));

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.76, startA, endA);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = r * 0.1;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.76, startA, startA + frac * rng);
    ctx.strokeStyle = (frac > 0.82) ? '#ef4444' : col;
    ctx.lineWidth = r * 0.1;
    ctx.lineCap = 'round';
    ctx.stroke();

    const needleA = startA + frac * rng;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(needleA);
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.lineTo(r * 0.65, 0);
    ctx.lineTo(0, 2);
    ctx.closePath();
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.14, 0, Math.PI * 2);
    ctx.fillStyle = '#334155';
    ctx.fill();

    ctx.font = `${Math.max(6, r * 0.2)}px sans-serif`;
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.fillText(unit, cx, cy + r * 0.45);
}

function drawTurnArrow(x, y, sz, isLeft) {
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    if (isLeft) {
        ctx.moveTo(x - sz, y);
        ctx.lineTo(x, y - sz * 0.6);
        ctx.lineTo(x, y - sz * 0.25);
        ctx.lineTo(x + sz * 0.6, y - sz * 0.25);
        ctx.lineTo(x + sz * 0.6, y + sz * 0.25);
        ctx.lineTo(x, y + sz * 0.25);
        ctx.lineTo(x, y + sz * 0.6);
    } else {
        ctx.moveTo(x + sz, y);
        ctx.lineTo(x, y - sz * 0.6);
        ctx.lineTo(x, y - sz * 0.25);
        ctx.lineTo(x - sz * 0.6, y - sz * 0.25);
        ctx.lineTo(x - sz * 0.6, y + sz * 0.25);
        ctx.lineTo(x, y + sz * 0.25);
        ctx.lineTo(x, y + sz * 0.6);
    }
    ctx.closePath();
    ctx.fill();
}

function renderSteeringWheelRHD(cx, cy, r, angleDeg) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleDeg * Math.PI / 180);

    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = r * 0.18;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, r, -Math.PI * 0.75, -Math.PI * 0.25);
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = r * 0.14;
    ctx.stroke();

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(-r * 0.98, -r * 0.45, r * 0.2, r * 0.35);
    ctx.fillRect( r * 0.78, -r * 0.45, r * 0.2, r * 0.35);

    const spokeAngles = [Math.PI * 1.5, Math.PI * 0.72, Math.PI * 0.28];
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = r * 0.12;
    ctx.lineCap = 'round';
    for (const a of spokeAngles) {
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.28, Math.sin(a) * r * 0.28);
        ctx.lineTo(Math.cos(a) * r * 0.88, Math.sin(a) * r * 0.88);
        ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(0, 0, r * 0.32, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    ctx.fillStyle = '#f8fafc';
    ctx.font = `bold ${Math.max(9, r * 0.24)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('❖', 0, 0);

    ctx.beginPath();
    ctx.moveTo(0, -r * 0.88);
    ctx.lineTo(0, -r * 1.08);
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.restore();
}

function drawRoundedRect(c, x, y, w, h, rad) {
    c.beginPath();
    c.moveTo(x + rad, y);
    c.lineTo(x + w - rad, y);
    c.arcTo(x + w, y, x + w, y + rad, rad);
    c.lineTo(x + w, y + h - rad);
    c.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    c.lineTo(x + rad, y + h);
    c.arcTo(x, y + h, x, y + h - rad, rad);
    c.lineTo(x, y + rad);
    c.arcTo(x, y, x + rad, y, rad);
    c.closePath();
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN ANIMATION LOOP
// ─────────────────────────────────────────────────────────────────────────────
function gameLoop(currentTime) {
    const dt = (currentTime - lastTime) / 1000;
    lastTime = currentTime;

    updatePhysics(dt);
    renderFrame();

    requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);
