/**
 * tracker_client.js
 * Modul Frontend Client untuk berkomunikasi dengan Backend Machine Learning Python (app.py & tracker_ml.py).
 * Mengatur sinkronisasi kemudi real-time, hidup/mati kamera manual, dan status DMS.
 */

const TrackerClient = {
    active: false,
    pollInterval: null,
    steerValue: 0.0,
    engineName: 'Menghubungkan ke Python ML...',
    fps: 0,
    faceDetected: false,
    direction: '• LURUS •',

    init() {
        this.bindEvents();
        this.checkBackendStatus();
    },

    bindEvents() {
        const btnToggle = document.getElementById('btn-cam');
        const btnClose = document.getElementById('btn-cam-close');
        const btnStopDirect = document.getElementById('btn-cam-off-direct');
        const btnRecalibrate = document.getElementById('btn-recalibrate');

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

        if (btnRecalibrate) {
            btnRecalibrate.addEventListener('click', () => {
                this.recalibrate();
                if (typeof playClick === 'function') playClick();
            });
        }

        // Shortcut tombol C pada keyboard
        window.addEventListener('keydown', (e) => {
            if (e.code === 'KeyC') {
                this.toggleCamera();
                if (typeof playClick === 'function') playClick();
            }
        });
    },

    async checkBackendStatus() {
        try {
            const res = await fetch('/api/status');
            if (res.ok) {
                const data = await res.json();
                this.engineName = data.engine;
                this.updateEngineBadge(data.engine);
                if (data.active) {
                    this.startPolling();
                    this.updateUIState(true);
                }
            }
        } catch (e) {
            console.log('[TrackerClient] Backend Python belum terhubung, menggunakan mode fallback:', e);
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
        try {
            const res = await fetch('/api/camera/start', { method: 'POST' });
            if (res.ok) {
                this.active = true;
                this.startPolling();
                this.updateUIState(true);
                this.showToast('📷 Kamera Python ML Diaktifkan! Gerakkan kepala untuk menyetir.');
                this.startVideoFeed();
            }
        } catch (err) {
            console.warn('[TrackerClient] Gagal memanggil Python /api/camera/start:', err);
            // Fallback interaktif lokal jika server offline
            this.active = true;
            this.updateUIState(true);
            this.showToast('🟡 Kamera Aktif (Mode Siap Python ML).');
        }
    },

    async stopCamera() {
        try {
            await fetch('/api/camera/stop', { method: 'POST' });
        } catch (err) {
            console.warn('[TrackerClient] Error calling stop:', err);
        }

        this.active = false;
        this.steerValue = 0.0;
        this.stopPolling();
        this.updateUIState(false);
        this.stopVideoFeed();
        this.showToast('⏹ Kamera Dimatikan. Kontrol stir kembali ke Keyboard (A/D & Panah).', false);
    },

    async recalibrate() {
        try {
            await fetch('/api/camera/calibrate', { method: 'POST' });
            this.showToast('🎯 Posisi kepala berhasil dikalibrasi!');
        } catch (err) {
            console.warn('[TrackerClient] Calibrate failed:', err);
        }
    },

    startPolling() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        // Polling status kemudi dari Python ML (60 FPS = ~16ms)
        this.pollInterval = setInterval(async () => {
            if (!this.active) return;
            try {
                const res = await fetch('/api/status');
                if (res.ok) {
                    const data = await res.json();
                    this.steerValue = data.steer;
                    this.fps = data.fps || 60;
                    this.faceDetected = data.face_detected;
                    this.direction = data.direction;
                    this.updateMeterUI();
                }
            } catch (err) {
                // Ignore network errors in loop
            }
        }, 20);
    },

    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.updateMeterUI();
    },

    startVideoFeed() {
        const previewCanvas = document.getElementById('camPreviewCanvas');
        if (!previewCanvas) return;
        const pctx = previewCanvas.getContext('2d');

        // Gunakan stream image dari Python ML /video_feed
        const streamImg = new Image();
        streamImg.crossOrigin = 'anonymous';
        streamImg.src = '/video_feed?' + Date.now();

        this._streamImg = streamImg;
        this._streamLoop = () => {
            if (!this.active) return;
            if (streamImg.complete && streamImg.naturalWidth > 0) {
                pctx.drawImage(streamImg, 0, 0, previewCanvas.width, previewCanvas.height);
            }
            requestAnimationFrame(this._streamLoop);
        };
        requestAnimationFrame(this._streamLoop);
    },

    stopVideoFeed() {
        if (this._streamImg) {
            this._streamImg.src = '';
            this._streamImg = null;
        }
        const previewCanvas = document.getElementById('camPreviewCanvas');
        if (previewCanvas) {
            const pctx = previewCanvas.getContext('2d');
            pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        }
    },

    updateUIState(isOn) {
        const btnCam = document.getElementById('btn-cam');
        const badgeState = document.getElementById('cam-badge-state');
        const panel = document.getElementById('cam-panel');

        if (isOn) {
            if (btnCam) btnCam.classList.add('active');
            if (badgeState) {
                badgeState.className = 'cam-badge-status on';
                badgeState.textContent = 'HIDUP';
            }
            if (panel) panel.classList.add('visible');
        } else {
            if (btnCam) btnCam.classList.remove('active');
            if (badgeState) {
                badgeState.className = 'cam-badge-status off';
                badgeState.textContent = 'MATI';
            }
            if (panel) panel.classList.remove('visible');
        }
    },

    updateEngineBadge(engineName) {
        const fpsEl = document.getElementById('camFps');
        if (fpsEl && engineName) {
            fpsEl.textContent = engineName.includes('MediaPipe') ? 'MediaPipe ML' : 'Python ML';
        }
    },

    updateMeterUI() {
        const bar = document.getElementById('steer-meter-bar');
        const status = document.getElementById('meterStatus');
        if (!bar || !status) return;

        const percent = Math.round(Math.abs(this.steerValue) * 100);

        if (this.steerValue < -0.05) {
            bar.className = 'left';
            bar.style.left = `${50 - (percent / 2)}%`;
            bar.style.width = `${percent / 2}%`;
            status.textContent = `◄ KIRI ${percent}%`;
            status.style.color = '#22c55e';
        } else if (this.steerValue > 0.05) {
            bar.className = 'right';
            bar.style.left = '50%';
            bar.style.width = `${percent / 2}%`;
            status.textContent = `KANAN ${percent}% ►`;
            status.style.color = '#f59e0b';
        } else {
            bar.style.width = '0%';
            status.textContent = '• NETRAL •';
            status.style.color = '#38bdf8';
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

// Jalankan saat DOM siap
window.addEventListener('DOMContentLoaded', () => {
    TrackerClient.init();
});
