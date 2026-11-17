"""
tracker_ml.py
Sistem Machine Learning & Computer Vision untuk Head-Tracking Pengemudi (POV Supir).
Mendeteksi orientasi kepala (Roll / Miring, Yaw / Toleh, dan X / Geser Lateral)
untuk mengendalikan stir mobil secara real-time, presisi, dan tanpa lag.
"""

import time
import math
import threading

# Cek ketersediaan pustaka Computer Vision / Machine Learning
HAS_CV2 = False
HAS_MEDIAPIPE = False

try:
    import cv2
    import numpy as np
    HAS_CV2 = True
except ImportError:
    pass

try:
    import mediapipe as mp
    HAS_MEDIAPIPE = True
except ImportError:
    pass


class HeadTrackerML:
    def __init__(self):
        self.active = False
        self.thread = None
        self.lock = threading.Lock()

        # Output status kemudi
        self.steer_value = 0.0      # -1.0 (Full Kiri) s/d +1.0 (Full Kanan)
        self.head_yaw = 0.0         # Derajat toleh kepala
        self.head_roll = 0.0        # Derajat miring kepala
        self.head_lean = 0.0        # Geser lateral kepala
        self.fps = 0
        self.face_detected = False

        # Pengaturan sensor & kalibrasi
        self.calibrated = False
        self.calib_countdown = 20
        self.neutral_x = 0.5
        self.neutral_roll = 0.0
        self.neutral_yaw = 0.0

        self.sensitivity = 1.4      # Sensitivitas kemudi
        self.deadzone = 0.04        # Zona mati tengah (4%)
        self.inverted = False       # Pembalik arah kemudi jika diinginkan

        # Buffer frame gambar JPEG terkini untuk streaming ke web
        self.latest_jpeg = None

        # Engine ML info
        if HAS_MEDIAPIPE and HAS_CV2:
            self.engine_name = "MediaPipe FaceMesh (ML 468-Landmarks)"
        elif HAS_CV2:
            self.engine_name = "OpenCV Haar/Facial Landmark Tracker"
        else:
            self.engine_name = "Python ML Engine (Siap Upgrade MediaPipe/OpenCV)"

    def start(self):
        with self.lock:
            if self.active:
                return
            self.active = True
            self.calibrated = False
            self.calib_countdown = 20
            self.thread = threading.Thread(target=self._tracking_loop, daemon=True)
            self.thread.start()
            print(f"[Python ML] Head Tracker diaktifkan menggunakan: {self.engine_name}")

    def stop(self):
        with self.lock:
            self.active = False
            self.steer_value = 0.0
            self.latest_jpeg = None
            print("[Python ML] Head Tracker dinonaktifkan.")

    def calibrate(self):
        with self.lock:
            self.calibrated = False
            self.calib_countdown = 20
            print("[Python ML] Kalibrasi posisi netral dimulai ulang.")

    def set_config(self, sensitivity=None, inverted=None):
        with self.lock:
            if sensitivity is not None:
                self.sensitivity = max(0.5, min(3.0, float(sensitivity)))
            if inverted is not None:
                self.inverted = bool(inverted)

    def sync_from_client(self, steer, roll=0.0, yaw=0.0, face_detected=True):
        """Sinkronisasi status dari Web Client (Webcam Browser)."""
        with self.lock:
            self.steer_value = max(-1.0, min(1.0, float(steer)))
            self.head_roll = float(roll)
            self.head_yaw = float(yaw)
            self.face_detected = bool(face_detected)

    def get_status(self):
        with self.lock:
            direction = "• LURUS •"
            pct = abs(int(self.steer_value * 100))
            if self.steer_value < -0.04:
                direction = f"◄ KIRI {pct}%"
            elif self.steer_value > 0.04:
                direction = f"KANAN {pct}% ►"

            return {
                "active": self.active,
                "steer": round(self.steer_value, 3),
                "direction": direction,
                "face_detected": self.face_detected,
                "roll": round(self.head_roll, 1),
                "yaw": round(self.head_yaw, 2),
                "fps": self.fps,
                "engine": self.engine_name,
                "has_mediapipe": HAS_MEDIAPIPE,
                "has_cv2": HAS_CV2,
                "calibrated": self.calibrated,
                "sensitivity": self.sensitivity,
                "inverted": self.inverted
            }

    def get_latest_jpeg(self):
        with self.lock:
            return self.latest_jpeg

    def _tracking_loop(self):
        if HAS_MEDIAPIPE and HAS_CV2:
            self._mediapipe_loop()
        elif HAS_CV2:
            self._opencv_loop()
        else:
            self._standby_loop()

    # ── 1. Pipeline ML MediaPipe Face Mesh (High Precision 468 Landmarks) ──
    def _mediapipe_loop(self):
        cap = cv2.VideoCapture(0)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 320)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 240)
        cap.set(cv2.CAP_PROP_FPS, 60)

        mp_face_mesh = mp.solutions.face_mesh
        face_mesh = mp_face_mesh.FaceMesh(
            max_num_faces=1,
            refine_landmarks=True,
            min_detection_confidence=0.5,
            min_tracking_confidence=0.5
        )

        frame_count = 0
        fps_start = time.time()

        while self.active:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.02)
                continue

            # Mirror horizontal agar gambar terlihat seperti cermin alami
            frame = cv2.flip(frame, 1)
            h, w, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = face_mesh.process(rgb_frame)

            if results.multi_face_landmarks:
                self.face_detected = True
                lm = results.multi_face_landmarks[0].landmark

                # Landmark MediaPipe (pada gambar yang sudah di-flip):
                # 33  = Sudut mata kiri luar (berada di sisi kiri gambar cermin)
                # 263 = Sudut mata kanan luar (berada di sisi kanan gambar cermin)
                # 1   = Ujung hidung (nose tip)
                # 234 = Tepi pipi/telinga kiri
                # 454 = Tepi pipi/telinga kanan
                left_eye = lm[33]
                right_eye = lm[263]
                nose = lm[1]

                # Koordinat 2D
                lx, ly = left_eye.x, left_eye.y
                rx, ry = right_eye.x, right_eye.y
                nx, ny = nose.x, nose.y

                # 1. Sudut Kemiringan Kepala (Roll):
                # Ketika miring kanan: telinga kanan turun => ry > ly => atan2(ry - ly, rx - lx) > 0 (POSITIF = KANAN)
                # Ketika miring kiri:  telinga kiri turun  => ly > ry => atan2(ry - ly, rx - lx) < 0 (NEGATIF = KIRI)
                eye_dx = rx - lx
                eye_dy = ry - ly
                roll_deg = math.atan2(eye_dy, max(0.01, eye_dx)) * (180.0 / math.pi)

                # 2. Sudut Toleh Kepala (Yaw):
                # Ketika toleh kanan: hidung bergerak mendekati mata kanan => dist_l > dist_r => (dist_l - dist_r) > 0 (POSITIF = KANAN)
                # Ketika toleh kiri:  hidung bergerak mendekati mata kiri  => dist_r > dist_l => (dist_l - dist_r) < 0 (NEGATIF = KIRI)
                dist_l = abs(nx - lx)
                dist_r = abs(rx - nx)
                eye_dist = max(0.01, abs(rx - lx))
                yaw_ratio = (dist_l - dist_r) / eye_dist

                # 3. Geser Lateral Badan (Lean):
                mid_x = (lx + rx) / 2.0

                # Kalibrasi awal (menangkap posisi duduk netral pengemudi)
                if not self.calibrated or self.calib_countdown > 0:
                    self.neutral_x = mid_x
                    self.neutral_roll = roll_deg
                    self.neutral_yaw = yaw_ratio
                    self.calib_countdown -= 1
                    if self.calib_countdown <= 0:
                        self.calibrated = True

                # Deviasi relatif terhadap posisi netral
                diff_roll = (roll_deg - self.neutral_roll) * 0.045
                diff_yaw = (yaw_ratio - self.neutral_yaw) * 2.0
                diff_lean = (mid_x - self.neutral_x) * 2.5

                # Gabungkan semua komponen (semua bertanda POSITIF untuk KANAN, NEGATIF untuk KIRI)
                raw_steer = (diff_roll * 0.55 + diff_yaw * 0.50 + diff_lean * 0.25) * self.sensitivity

                if self.inverted:
                    raw_steer = -raw_steer

                # Terapkan Filter Deadzone (mencegah goyang saat posisi tegak netral)
                abs_s = abs(raw_steer)
                target_steer = 0.0
                if abs_s > self.deadzone:
                    mag = (abs_s - self.deadzone) / (1.0 - self.deadzone)
                    target_steer = math.copysign(min(1.0, math.pow(mag, 1.15)), raw_steer)

                # Filter eksponensial responsif tanpa lag
                self.steer_value += (target_steer - self.steer_value) * 0.40
                self.head_roll = roll_deg
                self.head_yaw = yaw_ratio

                # Visualisasi overlay pada frame
                cx, cy = int(nx * w), int(ny * h)
                cv2.circle(frame, (cx, cy), 5, (56, 189, 248), -1)
                cv2.line(frame, (int(lx * w), int(ly * h)), (int(rx * w), int(ry * h)), (34, 197, 94), 2)
            else:
                self.face_detected = False
                self.steer_value *= 0.85

            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            with self.lock:
                self.latest_jpeg = buffer.tobytes()

            frame_count += 1
            if time.time() - fps_start >= 1.0:
                self.fps = frame_count
                frame_count = 0
                fps_start = time.time()

        cap.release()

    # ── 2. Pipeline OpenCV Standar ──
    def _opencv_loop(self):
        cap = cv2.VideoCapture(0)
        face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
        eye_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_eye.xml')

        while self.active:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.02)
                continue

            frame = cv2.flip(frame, 1)
            h, w, _ = frame.shape
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(gray, 1.15, 5, minSize=(60, 60))

            if len(faces) > 0:
                self.face_detected = True
                fx, fy, fw, fh = faces[0]
                face_center_x = (fx + fw / 2.0) / w

                if not self.calibrated or self.calib_countdown > 0:
                    self.neutral_x = face_center_x
                    self.calib_countdown -= 1
                    if self.calib_countdown <= 0:
                        self.calibrated = True

                diff_x = (face_center_x - self.neutral_x) * 3.2 * self.sensitivity
                if self.inverted:
                    diff_x = -diff_x

                abs_s = abs(diff_x)
                target_steer = 0.0
                if abs_s > self.deadzone:
                    mag = (abs_s - self.deadzone) / (1.0 - self.deadzone)
                    target_steer = math.copysign(min(1.0, mag), diff_x)

                self.steer_value += (target_steer - self.steer_value) * 0.40
                cv2.rectangle(frame, (fx, fy), (fx + fw, fy + fh), (56, 189, 248), 2)
            else:
                self.face_detected = False
                self.steer_value *= 0.85

            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 65])
            with self.lock:
                self.latest_jpeg = buffer.tobytes()

            time.sleep(0.016)

        cap.release()

    # ── 3. Standby Loop ──
    def _standby_loop(self):
        while self.active:
            time.sleep(0.03)


# Singleton instance tracker ML
ml_tracker = HeadTrackerML()
