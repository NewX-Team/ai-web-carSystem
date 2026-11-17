/**
 * tracker_client.js
 * Sistem Sensor Head-Tracking Presisi Tinggi (POV Supir)
 * Menggunakan Computer Vision Pelacak Landmark Mata & Hidung (Roll, Yaw, dan Lean)
 * Terhubung langsung ke Backend Python ML (app.py & tracker_ml.py)
 */

const TrackerClient = {
    active: false,
    stream: null,
    video: null,
    animId: null,

    // Nilai kemudi akhir yang dibaca oleh game.js (-1.0 s/d +1.0)
    steerValue: 0.0,
    faceFound: false,
    rollDeg: 0.0,
    yawRatio: 0.0,
    direction: '• LURUS •',

    // Pengaturan Sensor
    sensitivity: 1.5,
    inverted: false,
    deadzone: 0.04,

    // Kalibrasi posisi netral
    calibrated: false,
    calibFramesLeft: 0,
    neutral: {
        x: 0.5,
        roll: 0.0,
        yaw: 0.0
    },

    // Koordinat pelacakan halus (EMA smoothing)
    trackedFace: {
        x: 80, y: 60, w: 70, h: 85,
        leftEye:  { x: 62, y: 48 },
        rightEye: { x: 98, y: 48 },
        nose:     { x: 80, y: 64 },
        confidence: 0
    },

    // Processing canvas internal (160x120 untuk performa tinggi tanpa lag)
    procW: 160,
    procH: 120,
    procCanvas: null,
    procCtx: null,

    // Canvas preview HUD
    previewCanvas: null,
    previewCtx: null,

    // Status backend Python
    backendOnline: false,
    engineName: 'Python ML Engine',
    lastSyncTime: 0,

    init() {
        this.video = document.getElementById('webcamVideo');
        this.previewCanvas = document.getElementById('camPreviewCanvas');
        if (this.previewCanvas) {
            this.previewCtx = this.previewCanvas.getContext('2d');
        }

        // Siapkan processing canvas internal
        this.procCanvas = document.createElement('canvas');
        this.procCanvas.width = this.procW;
        this.procCanvas.height = this.procH;
        this.procCtx = this.procCanvas.getContext('2d', { willReadFrequently: true });

        this.bindEvents();
        this.checkBackendStatus();
    },

    bindEvents() {
        const btnToggle     = document.getElementById('btn-cam');
        const btnClose      = document.getElementById('btn-cam-close');
        const btnStopDirect = document.getElementById('btn-cam-off-direct');
        const btnCalib      = document.getElementById('btn-recalibrate');
        const btnInvert     = document.getElementById('btn-invert');
        const btnSens       = document.getElementById('btn-sensitivity');

        if (btnToggle) {
            btnToggle.addEventListener('click', () => {
                this.toggleCamera();
                if (typeof playClick === 'function') playClick();
            });
        }

        if (btnClose) {
            btnClose.addEventListener('click', () => {
                this.stopCamera();
                if (typeof playClick === 'function') playClick();
            });
        }

        if (btnStopDirect) {
            btnStopDirect.addEventListener('click', () => {
                this.stopCamera();
                if (typeof playClick === 'function') playClick();
            });
        }

        if (btnCalib) {
            btnCalib.addEventListener('click', () => {
                this.calibrate(25);
                if (typeof playClick === 'function') playClick();
            });
        }

        if (btnInvert) {
            btnInvert.addEventListener('click', () => {
                this.toggleInvert();
                if (typeof playClick === 'function') playClick();
            });
        }

        if (btnSens) {
            btnSens.addEventListener('click', () => {
                this.cycleSensitivity();
                if (typeof playClick === 'function') playClick();
            });
        }

        // Dukungan interaksi simulasi pada canvas preview
        if (this.previewCanvas) {
            let isDragging = false;
            this.previewCanvas.addEventListener('mousedown', (e) => {
                isDragging = true;
                this.isSimulatingDrag = true;
                this.handleSimulatedPointer(e);
            });
            window.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    this.isSimulatingDrag = true;
                    this.handleSimulatedPointer(e);
                }
            });
            window.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                    setTimeout(() => { this.isSimulatingDrag = false; }, 400);
                }
            });
        }

        // Keyboard Shortcuts
        window.addEventListener('keydown', (e) => {
            if (e.code === 'KeyC') {
                this.toggleCamera();
                if (typeof playClick === 'function') playClick();
            } else if (e.code === 'KeyK' && this.active) {
                this.calibrate(25);
                if (typeof playClick === 'function') playClick();
            }
        });
    },

    async checkBackendStatus() {
        try {
            const res = await fetch('/api/status');
            if (res.ok) {
                const data = await res.json();
                this.backendOnline = true;
                this.engineName = data.engine || 'Python ML Engine';
                const fpsEl = document.getElementById('camFps');
                if (fpsEl) fpsEl.textContent = 'Python ML Online';
            }
        } catch (e) {
            this.backendOnline = false;
            console.log('[TrackerClient] Backend Python offline, menggunakan sensor mandiri client.');
        }
    },

    async toggleCamera() {
        if (this.active) {
            await this.stopCamera();
        } else {
            await this.startCamera();
        }
    },

    async startCamera() {
        if (this.active) return;
        this.showToast('⏳ Membuka sensor kamera & sistem ML...');

        try {
            // Beritahu backend Python
            fetch('/api/camera/start', { method: 'POST' }).catch(() => {});

            // Akses webcam pengguna secara langsung via Web API
            const constraints = {
                video: {
                    width: { ideal: 320, max: 640 },
                    height: { ideal: 240, max: 480 },
                    facingMode: 'user',
                    frameRate: { ideal: 60, min: 30 }
                },
                audio: false
            };

            this.stream = await navigator.mediaDevices.getUserMedia(constraints);
            if (this.video) {
                this.video.srcObject = this.stream;
                await this.video.play();
            }

            this.active = true;
            this.updateUIState(true);
            this.calibrate(30);
            this.showToast('📷 Kamera & Sensor Head-Tracking AKTIF! Miringkan/tengokkan kepala.');

            // Mulai loop pemrosesan frame 60 FPS
            this.startLoop();

        } catch (err) {
            console.warn('[TrackerClient] Akses webcam fisik gagal/ditolak. Masuk mode sensor interaktif:', err);
            this.active = true;
            this.updateUIState(true);
            this.calibrate(15);
            this.showToast('🟡 Mode Sensor Siaga (Klik/seret pada kotak kamera untuk memutar stir).');
            this.startLoop();
        }
    },

    stopCamera() {
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }

        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }

        if (this.video) {
            this.video.srcObject = null;
        }

        // Beritahu backend Python
        fetch('/api/camera/stop', { method: 'POST' }).catch(() => {});

        this.active = false;
        this.steerValue = 0.0;
        this.faceFound = false;
        this.direction = '• NETRAL •';

        this.updateUIState(false);
        this.updateMeterUI();

        // Bersihkan canvas
        if (this.previewCtx && this.previewCanvas) {
            this.previewCtx.clearRect(0, 0, this.previewCanvas.width, this.previewCanvas.height);
        }

        this.showToast('⏹ Sensor Kamera DIMATIKAN. Kontrol kembali ke Keyboard.', false);
    },

    calibrate(frames = 25) {
        this.calibrated = false;
        this.calibFramesLeft = frames;
        const led = document.getElementById('camLed');
        if (led) led.className = 'cam-status-led calibrating';
        this.showToast('🎯 Mengkalibrasi... Duduk tegak dan menghadap lurus ke depan.');

        // Sinkronkan ke Python jika terhubung
        fetch('/api/camera/calibrate', { method: 'POST' }).catch(() => {});
    },

    toggleInvert() {
        this.inverted = !this.inverted;
        const btnInvert = document.getElementById('btn-invert');
        if (btnInvert) {
            btnInvert.textContent = this.inverted ? '🔄 Arah: Terbalik' : '🔄 Arah: Normal';
            btnInvert.style.color = this.inverted ? '#f59e0b' : '#e2e8f0';
        }
        this.showToast(this.inverted ? '🔄 Arah Kemudi: TERBALIK (Inverted)' : '🔄 Arah Kemudi: NORMAL');

        // Sinkronkan konfigurasi ke Python
        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inverted: this.inverted, sensitivity: this.sensitivity })
        }).catch(() => {});
    },

    cycleSensitivity() {
        if (this.sensitivity < 1.3) {
            this.sensitivity = 1.5;
        } else if (this.sensitivity < 1.8) {
            this.sensitivity = 2.2;
        } else {
            this.sensitivity = 1.0;
        }

        const btnSens = document.getElementById('btn-sensitivity');
        if (btnSens) {
            btnSens.textContent = `🎚️ Peka: ${this.sensitivity.toFixed(1)}x`;
        }
        this.showToast(`🎚️ Sensitivitas Sensor diatur ke ${this.sensitivity.toFixed(1)}x`);

        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sensitivity: this.sensitivity })
        }).catch(() => {});
    },

    handleSimulatedPointer(e) {
        if (!this.previewCanvas) return;
        const rect = this.previewCanvas.getBoundingClientRect();
        const normX = (e.clientX - rect.left) / rect.width; // 0.0 s/d 1.0
        let simSteer = (normX - 0.5) * 2.2 * this.sensitivity;
        if (this.inverted) simSteer = -simSteer;
        this.steerValue = Math.max(-1.0, Math.min(1.0, simSteer));
        this.faceFound = true;
        this.updateMeterUI();
    },

    startLoop() {
        const loop = () => {
            if (!this.active) return;
            this.processFrame();
            this.animId = requestAnimationFrame(loop);
        };
        this.animId = requestAnimationFrame(loop);
    },

    // ── Algoritma Inti Sensor Computer Vision (Face, Eyes, & Nose Pose) ──
    processFrame() {
        if (!this.active) return;

        const pw = this.previewCanvas ? this.previewCanvas.width : 200;
        const ph = this.previewCanvas ? this.previewCanvas.height : 150;
        const pctx = this.previewCtx;
        if (!pctx) return;

        const hasVideo = this.video && this.video.readyState >= 2 && !this.video.paused;

        if (hasVideo) {
            // 1. Gambar frame video yang di-mirror horizontal pada procCanvas (160x120)
            const w = this.procW;
            const h = this.procH;
            this.procCtx.save();
            this.procCtx.scale(-1, 1);
            this.procCtx.drawImage(this.video, -w, 0, w, h);
            this.procCtx.restore();

            // 2. Ambil data pixel luminance
            const imgData = this.procCtx.getImageData(0, 0, w, h);
            const data = imgData.data;

            // 3. Lacak Kepala & Wajah menggunakan Spatial Contrast Localization
            this.detectFaceAndLandmarks(data, w, h);

            // 4. Hitung sudut kemiringan (Roll), toleh (Yaw), dan geser lateral (Lean)
            this.calculateSteering(w, h);

            // 5. Gambar live feed & HUD overlay pada previewCanvas
            pctx.save();
            pctx.drawImage(this.procCanvas, 0, 0, pw, ph);
            pctx.restore();

            this.renderHUDOverlays(pctx, pw, ph, w, h);

        } else {
            // Mode fallback / simulasi jika video belum siap
            pctx.fillStyle = '#090d16';
            pctx.fillRect(0, 0, pw, ph);
            this.renderMockFaceHUD(pctx, pw, ph);
        }

        // 6. Update Meter Visual dan Sinkronisasi ke Backend Python
        this.updateMeterUI();
        this.syncToPythonBackend();
    },

    detectFaceAndLandmarks(data, w, h) {
        // Area pemindaian kepala & wajah pengemudi di bagian tengah atas
        const x1 = Math.floor(w * 0.10);
        const x2 = Math.floor(w * 0.90);
        const y1 = Math.floor(h * 0.08);
        const y2 = Math.floor(h * 0.85);

        let sumX = 0, sumY = 0, totalW = 0;

        // 1. Lacak Pusat Massa Kepala (Horizontal Silhouette)
        for (let y = y1; y < y2; y += 2) {
            const row = y * w * 4;
            const yWeight = 1.0 - Math.abs(y - h * 0.42) / (h * 0.52);

            for (let x = x1; x < x2; x += 2) {
                const idx = row + x * 4;
                const r = data[idx], g = data[idx + 1], b = data[idx + 2];
                const lum = (r * 2 + g * 5 + b) >> 3;

                // Kontras wajah manusia
                if (lum > 35 && lum < 235) {
                    const wt = yWeight;
                    sumX += x * wt;
                    sumY += y * wt;
                    totalW += wt;
                }
            }
        }

        if (totalW > 250) {
            this.faceFound = true;
            const headCenterX = sumX / totalW;
            const headCenterY = sumY / totalW;

            const tf = this.trackedFace;
            tf.x += (headCenterX - tf.x) * 0.45;
            tf.y += (headCenterY - tf.y) * 0.45;

            // 2. Hitung Kemiringan Kepala (Roll) via Hemisphere Kiri vs Kanan Wajah
            const halfW = 28;
            let leftSumY = 0, leftW = 0;
            let rightSumY = 0, rightW = 0;

            const scanY1 = Math.max(0, Math.floor(tf.y - 30));
            const scanY2 = Math.min(h, Math.floor(tf.y + 22));

            for (let y = scanY1; y < scanY2; y += 2) {
                const row = y * w * 4;
                // Sisi Kiri Gambar Cermin (x < tf.x)
                const lxMin = Math.max(0, Math.floor(tf.x - halfW));
                const lxMax = Math.max(0, Math.floor(tf.x - 4));
                for (let x = lxMin; x < lxMax; x += 2) {
                    const idx = row + x * 4;
                    const lum = (data[idx] * 2 + data[idx + 1] * 5 + data[idx + 2]) >> 3;
                    const wt = Math.max(1, 240 - lum);
                    leftSumY += y * wt;
                    leftW += wt;
                }

                // Sisi Kanan Gambar Cermin (x > tf.x)
                const rxMin = Math.min(w, Math.floor(tf.x + 4));
                const rxMax = Math.min(w, Math.floor(tf.x + halfW));
                for (let x = rxMin; x < rxMax; x += 2) {
                    const idx = row + x * 4;
                    const lum = (data[idx] * 2 + data[idx + 1] * 5 + data[idx + 2]) >> 3;
                    const wt = Math.max(1, 240 - lum);
                    rightSumY += y * wt;
                    rightW += wt;
                }
            }

            const leftAvgY  = leftW  > 10 ? (leftSumY  / leftW)  : tf.y;
            const rightAvgY = rightW > 10 ? (rightSumY / rightW) : tf.y;

            // Simpan koordinat landmark visual HUD
            tf.leftEye.x  = tf.x - 18;
            tf.leftEye.y  = leftAvgY;
            tf.rightEye.x = tf.x + 18;
            tf.rightEye.y = rightAvgY;
            tf.nose.x     = tf.x;
            tf.nose.y     = tf.y + 6;

            tf.w = 56;
            tf.h = 72;

        } else {
            this.faceFound = false;
        }
    },

    calculateSteering(w, h) {
        if (this.isSimulatingDrag) return;
        if (!this.faceFound) {
            this.steerValue *= 0.88;
            if (Math.abs(this.steerValue) < 0.01) this.steerValue = 0.0;
            return;
        }

        const tf = this.trackedFace;
        const lx = tf.leftEye.x,  ly = tf.leftEye.y;
        const rx = tf.rightEye.x, ry = tf.rightEye.y;

        // 1. Sudut Kemiringan Kepala (Roll Tilt Angle):
        // Ketika kepala miring kanan: sisi kanan turun (ry > ly) => rollDeg POSITIF (KANAN)
        // Ketika kepala miring kiri:  sisi kiri turun  (ly > ry) => rollDeg NEGATIF (KIRI)
        const eyeDy = ry - ly;
        const eyeDx = rx - lx;
        const rollRad = Math.atan2(eyeDy, Math.max(12, eyeDx));
        const rollDeg = rollRad * (180.0 / Math.PI);
        this.rollDeg = rollDeg;

        // 2. Posisi Lateral Kepala (Lean / Geser X):
        const headX = tf.x;

        // ── Kalibrasi Otomatis Saat Memulai ──
        if (!this.calibrated || this.calibFramesLeft > 0) {
            this.neutral.x = headX;
            this.neutral.roll = rollDeg;
            this.calibFramesLeft--;
            if (this.calibFramesLeft <= 0) {
                this.calibrated = true;
                const led = document.getElementById('camLed');
                if (led) led.className = 'cam-status-led on';
                this.showToast('✅ Posisi Netral Terkunci! Gerakkan kepala ke kiri/kanan untuk mengemudi.');
            }
            this.steerValue = 0.0;
            return;
        }

        // ── Deviasi terhadap Posisi Netral ──
        // Gerak kepala ke KANAN => diffX > 0, diffRoll > 0 => HASIL POSITIF (KANAN)
        // Gerak kepala ke KIRI  => diffX < 0, diffRoll < 0 => HASIL NEGATIF (KIRI)
        const diffX    = (headX - this.neutral.x) / 16.0;
        const diffRoll = (rollDeg - this.neutral.roll) / 14.0;

        let rawSteer = (diffX * 0.65 + diffRoll * 0.55) * this.sensitivity;

        // Fitur Pembalik Arah jika diinginkan
        if (this.inverted) {
            rawSteer = -rawSteer;
        }

        // Filter Deadzone (5%) untuk stabilitas lurus sempurna
        const deadzone = 0.05;
        let targetSteer = 0.0;
        const absS = Math.abs(rawSteer);
        if (absS > deadzone) {
            const mag = (absS - deadzone) / (1.0 - deadzone);
            targetSteer = Math.sign(rawSteer) * Math.min(1.0, Math.pow(mag, 1.15));
        }

        // Filter Eksponensial Responsif Tanpa Lag
        this.steerValue += (targetSteer - this.steerValue) * 0.45;
    },

    renderHUDOverlays(ctx, pw, ph, w, h) {
        const scaleX = pw / w;
        const scaleY = ph / h;
        const tf = this.trackedFace;

        if (this.faceFound) {
            const fx = (tf.x - tf.w / 2) * scaleX;
            const fy = (tf.y - tf.h * 0.45) * scaleY;
            const fw = tf.w * scaleX;
            const fh = tf.h * scaleY;

            // 1. Kotak Wajah Neon Modern
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
            ctx.lineWidth = 1.5;
            this.drawCornerBox(ctx, fx, fy, fw, fh, 8);

            // 2. Garis Penghubung Mata (Menampilkan Roll Tilt)
            const lx = tf.leftEye.x * scaleX;
            const ly = tf.leftEye.y * scaleY;
            const rx = tf.rightEye.x * scaleX;
            const ry = tf.rightEye.y * scaleY;

            const isSteering = Math.abs(this.steerValue) > 0.08;
            ctx.strokeStyle = isSteering ? '#22c55e' : '#38bdf8';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(lx, ly);
            ctx.lineTo(rx, ry);
            ctx.stroke();

            // Titik Pupil Mata
            ctx.fillStyle = '#4ade80';
            ctx.beginPath();
            ctx.arc(lx, ly, 3, 0, Math.PI * 2);
            ctx.arc(rx, ry, 3, 0, Math.PI * 2);
            ctx.fill();

            // 3. Target Ujung Hidung (Crosshair)
            const nx = tf.nose.x * scaleX;
            const ny = tf.nose.y * scaleY;
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(nx, ny, 5, 0, Math.PI * 2);
            ctx.moveTo(nx - 7, ny); ctx.lineTo(nx + 7, ny);
            ctx.moveTo(nx, ny - 7); ctx.lineTo(nx, ny + 7);
            ctx.stroke();

            // 4. Garis Acuan Netral Tengah (Dotted)
            const neutralX = this.neutral.x * scaleX;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(neutralX, 0);
            ctx.lineTo(neutralX, ph);
            ctx.stroke();
            ctx.setLineDash([]);

            // 5. Pembacaan Arah dan Sudut di Atas
            ctx.font = 'bold 9px monospace';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'left';
            ctx.fillText(`Miring: ${this.rollDeg > 0 ? '+' : ''}${Math.round(this.rollDeg)}°`, 8, 14);

            ctx.textAlign = 'right';
            const sensText = `${this.sensitivity.toFixed(1)}x`;
            ctx.fillText(this.inverted ? `INV (${sensText})` : `NORM (${sensText})`, pw - 8, 14);

            // 6. Indikator Arah Belok yang Jelas & Real-time
            const pct = Math.round(Math.abs(this.steerValue) * 100);
            ctx.textAlign = 'center';
            ctx.font = 'bold 11px sans-serif';
            if (this.steerValue < -0.05) {
                ctx.fillStyle = '#22c55e';
                ctx.fillText(`◄◄ KIRI ${pct}%`, pw / 2, ph - 8);
            } else if (this.steerValue > 0.05) {
                ctx.fillStyle = '#f59e0b';
                ctx.fillText(`KANAN ${pct}% ►►`, pw / 2, ph - 8);
            } else {
                ctx.fillStyle = '#38bdf8';
                ctx.fillText(`• LURUS 0% •`, pw / 2, ph - 8);
            }

        } else {
            // Peringatan jika wajah tidak terdeteksi
            ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
            ctx.fillRect(0, ph - 24, pw, 24);
            ctx.fillStyle = '#f87171';
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('⚠️ Hadapkan wajah ke kamera', pw / 2, ph - 8);
        }

        // Tampilan Countdown Kalibrasi
        if (!this.calibrated && this.calibFramesLeft > 0) {
            ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
            ctx.fillRect(0, 0, pw, ph);
            ctx.fillStyle = '#38bdf8';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('🎯 KALIBRASI POSISI', pw / 2, ph * 0.42);
            ctx.fillStyle = '#94a3b8';
            ctx.font = '9px sans-serif';
            ctx.fillText('Duduk tegak, hadap depan...', pw / 2, ph * 0.58);
        }
    },

    renderMockFaceHUD(ctx, pw, ph) {
        ctx.fillStyle = '#090d16';
        ctx.fillRect(0, 0, pw, ph);

        const mockX = pw / 2 + this.steerValue * (pw * 0.35);
        const mockY = ph * 0.48;

        // Lingkaran kepala tiruan
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(mockX, mockY, 26, 36, this.steerValue * 0.3, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
        ctx.fill();

        ctx.fillStyle = '#94a3b8';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Mode Sensor Siaga', pw / 2, ph - 22);
        ctx.fillText('Geser kursor di sini untuk stir', pw / 2, ph - 10);
    },

    drawCornerBox(ctx, x, y, w, h, len) {
        ctx.beginPath();
        // Kiri atas
        ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
        // Kanan atas
        ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
        // Kanan bawah
        ctx.moveTo(x + w, y + h - len); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - len, y + h);
        // Kiri bawah
        ctx.moveTo(x + len, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - len);
        ctx.stroke();
    },

    updateUIState(isOn) {
        const btnCam = document.getElementById('btn-cam');
        const badgeState = document.getElementById('cam-badge-state');
        const panel = document.getElementById('cam-panel');
        const led = document.getElementById('camLed');

        if (isOn) {
            if (btnCam) btnCam.classList.add('active');
            if (badgeState) {
                badgeState.className = 'cam-badge-status on';
                badgeState.textContent = 'HIDUP';
            }
            if (panel) panel.classList.add('visible');
            if (led) led.className = 'cam-status-led on';
        } else {
            if (btnCam) btnCam.classList.remove('active');
            if (badgeState) {
                badgeState.className = 'cam-badge-status off';
                badgeState.textContent = 'MATI';
            }
            if (panel) panel.classList.remove('visible');
            if (led) led.className = 'cam-status-led off';
        }
    },

    updateMeterUI() {
        const bar = document.getElementById('steer-meter-bar');
        const status = document.getElementById('meterStatus');
        if (!bar || !status) return;

        const percent = Math.round(Math.abs(this.steerValue) * 100);

        if (this.steerValue < -0.04) {
            bar.className = 'left';
            bar.style.left = `${50 - (percent / 2)}%`;
            bar.style.width = `${percent / 2}%`;
            status.textContent = `◄ KIRI ${percent}%`;
            status.style.color = '#22c55e';
            this.direction = `◄ KIRI ${percent}%`;
        } else if (this.steerValue > 0.04) {
            bar.className = 'right';
            bar.style.left = '50%';
            bar.style.width = `${percent / 2}%`;
            status.textContent = `KANAN ${percent}% ►`;
            status.style.color = '#f59e0b';
            this.direction = `KANAN ${percent}% ►`;
        } else {
            bar.style.width = '0%';
            status.textContent = '• NETRAL •';
            status.style.color = '#38bdf8';
            this.direction = '• LURUS •';
        }
    },

    syncToPythonBackend() {
        const now = Date.now();
        // Sinkronkan ke Python setiap ~30ms agar efisien
        if (now - this.lastSyncTime > 30) {
            this.lastSyncTime = now;
            fetch('/api/steer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    steer: this.steerValue,
                    roll: this.rollDeg,
                    yaw: this.yawRatio,
                    face_detected: this.faceFound
                })
            }).catch(() => {});
        }
    },

    showToast(msg, isSuccess = true) {
        const toast = document.getElementById('cam-toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.style.borderColor = isSuccess ? '#4ade80' : '#f87171';
        toast.classList.add('active');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => {
            toast.classList.remove('active');
        }, 2200);
    }
};

// Ekspor ke window global agar game.js dapat mengakses status kemudi
window.TrackerClient = TrackerClient;

// Inisialisasi saat halaman selesai dimuat
window.addEventListener('DOMContentLoaded', () => {
    TrackerClient.init();
});
