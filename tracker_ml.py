"""
tracker_ml.py
Sistem Machine Learning & Computer Vision untuk Head-Tracking Pengemudi (POV Supir).
Menggunakan OpenCV dan MediaPipe Face Mesh untuk mendeteksi orientasi kepala (Yaw & Roll)
dan posisi lateral untuk mengendalikan stir mobil secara real-time tanpa lag.
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
        self.fps = 0
        self.face_detected = False
        
        # Kalibrasi posisi netral
        self.calibrated = False
        self.neutral_x = 0.5
        self.neutral_yaw = 0.0
        self.neutral_roll = 0.0
        self.sensitivity = 1.5
        self.deadzone = 0.05
        
        # Buffer frame gambar JPEG terkini untuk streaming ke web
        self.latest_jpeg = None
        
        # Engine ML info
        if HAS_MEDIAPIPE and HAS_CV2:
            self.engine_name = "MediaPipe FaceMesh (ML 468-Landmarks)"
        elif HAS_CV2:
            self.engine_name = "OpenCV Haar/Optical Tracker"
        else:
            self.engine_name = "Python Standard Tracker (Siap Upgrade MediaPipe)"

    def start(self):
        with self.lock:
            if self.active:
                return
            self.active = True
            self.calibrated = False
            self.thread = threading.Thread(target=self._tracking_loop, daemon=True)
            self.thread.start()
            print(f"[Python ML] Head Tracker diaktifkan menggunakan {self.engine_name}")

    def stop(self):
        with self.lock:
            self.active = False
            self.steer_value = 0.0
            self.latest_jpeg = None
            print("[Python ML] Head Tracker dimatikan. Hardware kamera dilepas.")

    def calibrate(self):
        self.calibrated = False
        print("[Python ML] Kalibrasi posisi tengah di-reset.")

    def get_status(self):
        with self.lock:
            direction = "• LURUS •"
            if self.steer_value < -0.08:
                direction = f"◄ KIRI {abs(int(self.steer_value * 100))}%"
            elif self.steer_value > 0.08:
                direction = f"KANAN {abs(int(self.steer_value * 100))}% ►"

            return {
                "active": self.active,
                "steer": round(self.steer_value, 3),
                "direction": direction,
                "face_detected": self.face_detected,
                "fps": self.fps,
                "engine": self.engine_name,
                "has_mediapipe": HAS_MEDIAPIPE,
                "has_cv2": HAS_CV2,
                "calibrated": self.calibrated
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
            self._mock_loop()

    # ── 1. Pipeline ML MediaPipe Face Mesh (High Accuracy 468 3D Landmarks) ──
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
        calib_counter = 20

        while self.active:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.02)
                continue

            # Mirror horizontal agar gerakan kepala terasa alami seperti cermin
            frame = cv2.flip(frame, 1)
            h, w, _ = frame.shape
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = face_mesh.process(rgb_frame)

            if results.multi_face_landmarks:
                self.face_detected = True
                landmarks = results.multi_face_landmarks[0].landmark

                # Landmark kunci:
                # 1 = Ujung hidung (Nose tip)
                # 33 = Ujung mata kiri luar
                # 263 = Ujung mata kanan luar
                # 10 = Dahi atas
                # 152 = Dagu bawah
                nose = landmarks[1]
                left_eye = landmarks[33]
                right_eye = landmarks[263]
                forehead = landmarks[10]
                chin = landmarks[152]

                nose_x = nose.x
                eye_dx = right_eye.x - left_eye.x
                eye_dy = right_eye.y - left_eye.y
                roll_angle = math.atan2(eye_dy, eye_dx) * (180.0 / math.pi)

                # Yaw ratio (jarak hidung ke mata kiri vs mata kanan)
                dist_left = abs(nose.x - left_eye.x)
                dist_right = abs(right_eye.x - nose.x)
                total_eye_dist = dist_left + dist_right
                yaw_ratio = (dist_left - dist_right) / max(0.001, total_eye_dist)

                # Kalibrasi awal (menangkap posisi netral pengemudi)
                if not self.calibrated or calib_counter > 0:
                    self.neutral_x = nose_x
                    self.neutral_roll = roll_angle
                    self.neutral_yaw = yaw_ratio
                    calib_counter -= 1
                    if calib_counter <= 0:
                        self.calibrated = True

                # Kalkulasi deviasi kemudi
                diff_x = (nose_x - self.neutral_x) * 3.2
                diff_roll = (roll_angle - self.neutral_roll) * 0.04
                diff_yaw = (yaw_ratio - self.neutral_yaw) * 1.6

                raw_steer = (diff_x * 0.6 + diff_roll * 0.4 + diff_yaw * 0.5) * self.sensitivity

                # Deadzone filter
                abs_s = abs(raw_steer)
                target_steer = 0.0
                if abs_s > self.deadzone:
                    scaled = (abs_s - self.deadzone) / (1.0 - self.deadzone)
                    target_steer = math.copysign(min(1.0, math.pow(scaled, 1.2)), raw_steer)

                # Filter eksponensial responsif tanpa lag
                self.steer_value += (target_steer - self.steer_value) * 0.45

                # Gambar overlay visual pada frame
                cx, cy = int(nose.x * w), int(nose.y * h)
                cv2.circle(frame, (cx, cy), 6, (56, 189, 248), -1)
                cv2.circle(frame, (cx, cy), 14, (255, 255, 255), 1)

                # Bar indikator kemudi
                bar_len = int(self.steer_value * 80)
                color = (34, 197, 94) if self.steer_value < 0 else (245, 158, 11)
                cv2.line(frame, (w // 2, h - 15), (w // 2 + bar_len, h - 15), color, 4)
            else:
                self.face_detected = False
                self.steer_value *= 0.85

            # Encode frame ke format JPEG
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

        while self.active:
            ret, frame = cap.read()
            if not ret:
                time.sleep(0.02)
                continue

            frame = cv2.flip(frame, 1)
            h, w, _ = frame.shape
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = face_cascade.detectMultiScale(gray, 1.2, 5, minSize=(60, 60))

            if len(faces) > 0:
                self.face_detected = True
                x, y, fw, fh = faces[0]
                face_center_x = (x + fw / 2.0) / w

                if not self.calibrated:
                    self.neutral_x = face_center_x
                    self.calibrated = True

                diff_x = (face_center_x - self.neutral_x) * 3.5 * self.sensitivity
                abs_s = abs(diff_x)
                target_steer = 0.0
                if abs_s > self.deadzone:
                    target_steer = math.copysign(min(1.0, (abs_s - self.deadzone) / (1.0 - self.deadzone)), diff_x)

                self.steer_value += (target_steer - self.steer_value) * 0.45

                cv2.rectangle(frame, (x, y), (x + fw, y + fh), (56, 189, 248), 2)
            else:
                self.face_detected = False
                self.steer_value *= 0.85

            _, buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 65])
            with self.lock:
                self.latest_jpeg = buffer.tobytes()

            time.sleep(0.016)

        cap.release()

    # ── 3. Fallback Simulasi / Standard (Saat OpenCV belum terinstall) ──
    def _mock_loop(self):
        while self.active:
            # Tetap sediakan status loop agar frontend web dapat terkoneksi lancar
            time.sleep(0.03)


# Singleton instance tracker ML
ml_tracker = HeadTrackerML()
