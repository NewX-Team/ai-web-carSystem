"""
app.py
Server Backend Python untuk Simulator Mengemudi Tol Indonesia.
Menghubungkan sistem Machine Learning Head-Tracking (tracker_ml.py)
dengan antarmuka Web 3D Canvas (HTML, CSS, JS).
"""

import os
import json
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from tracker_ml import ml_tracker

PORT = 8000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class DrivingSimHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_GET(self):
        # 1. API: Ambil status kemudi & kamera dari Machine Learning
        if self.path == '/api/status':
            status = ml_tracker.get_status()
            self._send_json(status)
            return

        # 2. API: Video stream MJPEG dari kamera ML Python
        elif self.path == '/video_feed':
            if not ml_tracker.active:
                self.send_error(404, "Camera not active")
                return

            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.end_headers()

            try:
                while ml_tracker.active:
                    frame = ml_tracker.get_latest_jpeg()
                    if frame:
                        self.wfile.write(b'--frame\r\n')
                        self.send_header('Content-Type', 'image/jpeg')
                        self.send_header('Content-Length', str(len(frame)))
                        self.end_headers()
                        self.wfile.write(frame)
                        self.wfile.write(b'\r\n')
                    time.sleep(0.02)
            except Exception:
                pass
            return

        # 3. Serve File Statis Web (HTML, CSS, JS)
        else:
            return super().do_GET()

    def do_POST(self):
        # 1. API: Hidupkan Kamera Head-Tracking Python ML
        if self.path == '/api/camera/start':
            ml_tracker.start()
            self._send_json({"success": True, "message": "Kamera Python ML diaktifkan"})
            return

        # 2. API: Matikan Kamera Head-Tracking Python ML
        elif self.path == '/api/camera/stop':
            ml_tracker.stop()
            self._send_json({"success": True, "message": "Kamera Python ML dimatikan"})
            return

        # 3. API: Kalibrasi Posisi Netral Tengah
        elif self.path == '/api/camera/calibrate':
            ml_tracker.calibrate()
            self._send_json({"success": True, "message": "Kalibrasi berhasil"})
            return

        # 4. API: Sinkronisasi Nilai Kemudi dari Web Bridge
        elif self.path == '/api/steer':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
                steer = float(data.get('steer', 0.0))
                roll = float(data.get('roll', 0.0))
                yaw = float(data.get('yaw', 0.0))
                face_detected = bool(data.get('face_detected', True))
                ml_tracker.sync_from_client(steer, roll, yaw, face_detected)
                self._send_json({"success": True})
            except Exception as e:
                self.send_error(400, str(e))
            return

        # 5. API: Konfigurasi Sensitivitas & Arah Kemudi
        elif self.path == '/api/config':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
                ml_tracker.set_config(
                    sensitivity=data.get('sensitivity'),
                    inverted=data.get('inverted')
                )
                self._send_json({"success": True, "config": ml_tracker.get_status()})
            except Exception as e:
                self.send_error(400, str(e))
            return

        else:
            self.send_error(404, "Endpoint not found")

    def _send_json(self, data, status_code=200):
        body = json.dumps(data).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Filter log streaming agar terminal bersih
        if '/api/status' in str(args) or '/video_feed' in str(args):
            return
        super().log_message(format, *args)


def run_server():
    server = ThreadedHTTPServer(('0.0.0.0', PORT), DrivingSimHandler)
    print("=" * 65)
    print("🚗 SIMULATOR MENGEMUDI TOL INDONESIA - PYTHON ML BACKEND")
    print(f"📡 Server Web & API berjalan di: http://localhost:{PORT}")
    print(f"🤖 Engine ML: {ml_tracker.engine_name}")
    print("=" * 65)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Server] Mematikan server...")
        ml_tracker.stop()
        server.server_close()


if __name__ == '__main__':
    run_server()
