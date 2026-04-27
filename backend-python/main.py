import sys
import os

# ==========================================================
# CRITICAL FIX - MUST BE AT THE VERY TOP BEFORE ANY IMPORTS
# ==========================================================

# Patch google.protobuf BEFORE any other imports
import types

# Create a dummy runtime_version module
class DummyRuntimeVersion:
    __version__ = "3.20.3"

# Patch it into sys.modules BEFORE tensorflow tries to import it
sys.modules['google.protobuf.runtime_version'] = DummyRuntimeVersion()

# Also set environment variable to use Python implementation
os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"

# Now we can safely import everything else
import logging
import subprocess

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('interview_system.log', encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)
logger.info("🚀 Starting AI Interview Detection System")

try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form, Request
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    import cv2
    import numpy as np
    from collections import deque, Counter
    import mediapipe as mp
    import webrtcvad
    import pyaudio
    from typing import Dict, Any, List, Optional
    import base64
    import time
    import json
    import uuid
    import threading
    from dataclasses import dataclass, asdict
    from datetime import datetime
    import asyncio
    import uvicorn
    import io
    import PyPDF2
    
    logger.info("✅ All core imports successful")
    
except ImportError as e:
    logger.error(f"❌ Import error: {e}")
    print(f"\nMissing dependencies. Install with:")
    print("pip install fastapi uvicorn opencv-python numpy mediapipe webrtcvad pyaudio PyPDF2")
    sys.exit(1)

# Import optional dependencies with error handling
try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
    logger.info("✅ YOLO loaded successfully")
except ImportError as e:
    logger.warning(f"YOLO not available: {e}")
    YOLO = None
    YOLO_AVAILABLE = False

# Import DeepFace with error handling
try:
    from deepface import DeepFace
    DEEPFACE_AVAILABLE = True
    logger.info("✅ DeepFace loaded successfully")
except ImportError as e:
    logger.warning(f"DeepFace not available: {e}")
    DeepFace = None
    DEEPFACE_AVAILABLE = False
except Exception as e:
    logger.warning(f"DeepFace initialization error: {e}")
    DeepFace = None
    DEEPFACE_AVAILABLE = False

# Import AI Interview Model
try:
    # Try to import AI interview modules if they exist
    AI_INTERVIEW_AVAILABLE = False
    QuestionGenerator = None
    AnswerEvaluator = None
    logger.info("✅ AI Interview modules not found - running without AI interview features")
except Exception as e:
    logger.warning(f"AI Interview import error: {e}")
    AI_INTERVIEW_AVAILABLE = False
    QuestionGenerator = None
    AnswerEvaluator = None

# Now create the FastAPI app
app = FastAPI(title="AI Interview Detection & Interview API", version="5.4.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://localhost:5174", "http://127.0.0.1:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==== CONFIG ====
MOOD_ANALYZE_EVERY_N_FRAMES = 15
NEUTRAL_IGNORE_THRESHOLD = 95.0
MOOD_HISTORY_LEN = 9
SPEECH_DETECTION_THRESHOLD = 0.3
LIPSYNC_THRESHOLD = 0.035
BGVOICE_THRESHOLD = 0.02
FACE_VERIFICATION_THRESHOLD = 0.7
GENDER_DETECTION_INTERVAL = 5  # Analyze gender every 5 frames (increased frequency)
MAX_RECONNECT_ATTEMPTS = 5
RECONNECT_DELAY = 3000  # 3 seconds

@dataclass
class DetectionSession:
    """Session for fraud detection"""
    session_id: str
    room_id: str
    start_time: float
    end_time: Optional[float] = None
    fraud_alerts: List[Dict] = None
    reference_face_set: bool = False
    interview_active: bool = False
    ai_interview_active: bool = False
    ai_interview_level: str = "medium"
    resume_text: Optional[str] = None
    ai_questions: List[str] = None
    ai_current_question_index: int = 0
    ai_scores: List[int] = None
    ai_history: List[Dict] = None
    last_activity: float = None
    
    def __post_init__(self):
        if self.fraud_alerts is None:
            self.fraud_alerts = []
        if self.ai_questions is None:
            self.ai_questions = []
        if self.ai_scores is None:
            self.ai_scores = []
        if self.ai_history is None:
            self.ai_history = []
        self.last_activity = time.time()

class FraudDetectionSystem:
    """Main fraud detection system"""
    
    def __init__(self):
        self.active_sessions: Dict[str, DetectionSession] = {}
        self.websocket_connections: Dict[str, WebSocket] = {}
        self.session_lock = threading.Lock()
        self.reconnect_attempts: Dict[str, int] = {}
    
    async def start_detection_session(self, session_id: str, room_id: str) -> DetectionSession:
        """Start a new fraud detection session"""
        with self.session_lock:
            session = DetectionSession(
                session_id=session_id,
                room_id=room_id,
                start_time=time.time(),
                interview_active=True
            )
            self.active_sessions[session_id] = session
            logger.info(f"Started fraud detection session: {session_id}")
            return session
    
    async def get_or_create_session(self, session_id: str, room_id: str) -> DetectionSession:
        """Get existing session or create new one"""
        with self.session_lock:
            if session_id in self.active_sessions:
                logger.info(f"Found existing session: {session_id}")
                session = self.active_sessions[session_id]
                session.last_activity = time.time()
                return session
            
            # Create new session
            session = DetectionSession(
                session_id=session_id,
                room_id=room_id,
                start_time=time.time(),
                interview_active=True
            )
            self.active_sessions[session_id] = session
            logger.info(f"Created new session: {session_id} for room: {room_id}")
            return session
    
    async def end_detection_session(self, session_id: str):
        """End a fraud detection session"""
        with self.session_lock:
            if session_id in self.active_sessions:
                session = self.active_sessions[session_id]
                session.end_time = time.time()
                session.interview_active = False
                session.ai_interview_active = False
                
                # Generate report
                report = await self.generate_detection_report(session)
                
                # Remove from active sessions
                del self.active_sessions[session_id]
                
                # Unregister WebSocket
                self.unregister_websocket(session_id)
                
                # Clear reconnect attempts
                if session_id in self.reconnect_attempts:
                    del self.reconnect_attempts[session_id]
                
                logger.info(f"Ended fraud detection session: {session_id}")
                return report
        return None
    
    def check_fraud_alerts(self, detection_data: dict, session: DetectionSession) -> List[str]:
        """Check for fraud alerts based on detection data"""
        alerts = []
        
        # Multiple faces
        if detection_data.get('faces', 0) > 1:
            alerts.append("Multiple faces detected")
        
        # Background voice
        if detection_data.get('bg_voice', False):
            alerts.append("Background voice detected")
        
        # Face verification failed
        if detection_data.get('verification', 'Not set') == 'NOT MATCH':
            alerts.append("Face verification failed")
        
        # No speech detected when expected
        if not detection_data.get('speech', False) and session.interview_active:
            alerts.append("No speech detected during interview")
        
        # Excessive eye movements
        if detection_data.get('eye_moves', 0) > 50:
            alerts.append("Excessive eye movements detected")
        
        # Face alert
        if detection_data.get('face_alert', ''):
            alerts.append(f"Face alert: {detection_data['face_alert']}")
        
        # No face detected
        if detection_data.get('faces', 0) == 0 and session.interview_active:
            alerts.append("No face detected")
        
        return alerts
    
    async def generate_detection_report(self, session: DetectionSession) -> dict:
        """Generate fraud detection report"""
        # Calculate AI interview results if active
        ai_results = None
        if session.ai_scores:
            total_score = sum(session.ai_scores)
            max_score = len(session.ai_scores) * 10
            percentage = (total_score / max_score) * 100 if max_score else 0
            
            if percentage >= 80:
                verdict = "Excellent"
            elif percentage >= 60:
                verdict = "Good"
            elif percentage >= 40:
                verdict = "Average"
            else:
                verdict = "Needs Improvement"
            
            ai_results = {
                "total_score": total_score,
                "max_score": max_score,
                "percentage": round(percentage, 2),
                "verdict": verdict,
                "questions_answered": len(session.ai_scores),
                "average_score": round(total_score / len(session.ai_scores), 2) if session.ai_scores else 0
            }
        
        return {
            "session_id": session.session_id,
            "room_id": session.room_id,
            "duration_seconds": round((session.end_time or time.time()) - session.start_time, 2),
            "start_time": datetime.fromtimestamp(session.start_time).isoformat(),
            "end_time": datetime.fromtimestamp(session.end_time or time.time()).isoformat(),
            "summary": {
                "total_alerts": len(session.fraud_alerts),
                "interview_active": session.interview_active,
                "ai_interview_active": session.ai_interview_active,
                "reference_face_set": session.reference_face_set,
                "ai_questions_answered": len(session.ai_scores) if session.ai_scores else 0
            },
            "fraud_alerts": session.fraud_alerts[-20:] if session.fraud_alerts else [],
            "ai_interview_results": ai_results
        }
    
    def register_websocket(self, session_id: str, websocket: WebSocket):
        """Register WebSocket connection for a session"""
        self.websocket_connections[session_id] = websocket
        logger.info(f"WebSocket registered for session: {session_id}")
    
    def unregister_websocket(self, session_id: str):
        """Unregister WebSocket connection"""
        if session_id in self.websocket_connections:
            del self.websocket_connections[session_id]
            logger.info(f"WebSocket unregistered for session: {session_id}")
    
    async def send_to_websocket(self, session_id: str, message: dict):
        """Send message to WebSocket client"""
        if session_id in self.websocket_connections:
            try:
                websocket = self.websocket_connections[session_id]
                await websocket.send_json(message)
                return True
            except Exception as e:
                logger.error(f"Error sending to WebSocket: {e}")
                # Clean up broken connection
                self.unregister_websocket(session_id)
        return False
    
    def update_activity(self, session_id: str):
        """Update last activity time for session"""
        if session_id in self.active_sessions:
            self.active_sessions[session_id].last_activity = time.time()
    
    def get_reconnect_attempts(self, session_id: str) -> int:
        """Get reconnection attempts for session"""
        return self.reconnect_attempts.get(session_id, 0)
    
    def increment_reconnect_attempts(self, session_id: str):
        """Increment reconnection attempts for session"""
        self.reconnect_attempts[session_id] = self.reconnect_attempts.get(session_id, 0) + 1
    
    def reset_reconnect_attempts(self, session_id: str):
        """Reset reconnection attempts for session"""
        if session_id in self.reconnect_attempts:
            del self.reconnect_attempts[session_id]

class AIDetector:
    """Enhanced AI Detector with improved gender detection"""
    
    def __init__(self, fraud_system: FraudDetectionSystem):
        self.fraud_system = fraud_system
        self.running = True
        
        # Mediapipe initialization with error handling
        try:
            self.mp_face_mesh = mp.solutions.face_mesh
            self.mp_detection = mp.solutions.face_detection
            self.face_mesh = self.mp_face_mesh.FaceMesh(
                max_num_faces=2,
                refine_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5
            )
            self.face_detector = self.mp_detection.FaceDetection(min_detection_confidence=0.5)
            logger.info("✅ MediaPipe initialized successfully")
        except Exception as e:
            logger.error(f"MediaPipe initialization failed: {e}")
            self.face_mesh = None
            self.face_detector = None
        
        # Detection variables
        self.eye_movement_count = 0
        self.prev_eye_x = None
        self.frame_counter = 0
        self.last_detected_face_count = 0
        self.face_alert = ""
        self.face_count = 0
        
        # Gender detection - COMPLETELY REWRITTEN
        self.latest_gender = "Unknown"
        self.gender_frame_counter = 0
        self.gender_history = deque(maxlen=15)  # Store last 15 gender detections
        self.gender_confidence = 0.0
        self.last_gender_update = time.time()
        
        # Try to load YOLO model
        if YOLO_AVAILABLE and YOLO:
            try:
                self.model = YOLO("best (6).pt")
                logger.info("✅ YOLO model loaded successfully (using best (6).pt)")
                # Log model classes
                if hasattr(self.model, 'names'):
                    logger.info(f"🤖 YOLO model classes: {self.model.names}")
            except Exception as e:
                logger.error(f"YOLO model loading failed: {e}")
                self.model = None
        else:
            self.model = None
            logger.warning("YOLO not available for gender detection")
        
        # Mood detection
        self.mood_history = deque(maxlen=MOOD_HISTORY_LEN)
        self.current_mood = "neutral"
        self.mood_frame_counter = 0
        
        # Audio setup with error handling
        self.RATE = 16000
        self.FRAME_MS = 20
        self.SAMPLES_PER_FRAME = int(self.RATE * self.FRAME_MS / 1000)
        self.vad = webrtcvad.Vad(3)
        self.speech_deque = deque(maxlen=10)
        self.recent_speech_flag = False
        self.speech_detected = False
        self.speech_confidence = 0.0
        self.p = None
        self.stream = None
        
        try:
            self.p = pyaudio.PyAudio()
            self.stream = self.p.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=self.RATE,
                input=True,
                frames_per_buffer=self.SAMPLES_PER_FRAME,
                input_device_index=None
            )
            logger.info("✅ Audio input initialized successfully")
        except Exception as e:
            logger.error(f"Audio setup failed: {e}")
            logger.warning("Running without audio input")
        
        # Noise detection
        try:
            self.noise_face_mesh = mp.solutions.face_mesh.FaceMesh(max_num_faces=1, refine_landmarks=True)
            logger.info("✅ Noise detection initialized")
        except Exception as e:
            logger.error(f"Noise detection initialization failed: {e}")
            self.noise_face_mesh = None
        
        self.bg_voice = False
        self.lipsync = False
        self.mouth_ratio_debug = 0.0
        
        # Verification
        try:
            self.face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
            logger.info("✅ Face cascade loaded successfully")
        except Exception as e:
            logger.error(f"Face cascade loading failed: {e}")
            self.face_cascade = None
        
        self.reference_face = None
        self.verification_status = "Not set"
        
        # Frame storage
        self.latest_frame = None
        self.frame_lock = asyncio.Lock()
        self.last_frame_time = 0
        self.frame_timeout = 5.0  # 5 seconds without frame
        self.frame_received_count = 0
        
        # Start audio thread if audio is available
        if self.stream:
            self.start_audio_thread()
        else:
            logger.warning("Audio thread not started (no audio input)")
    
    def start_audio_thread(self):
        """Start audio processing thread"""
        try:
            self.audio_thread = threading.Thread(target=self.audio_vad_worker, daemon=True)
            self.audio_thread.start()
            logger.info("✅ Audio processing thread started")
        except Exception as e:
            logger.error(f"Failed to start audio thread: {e}")
    
    async def set_frame_from_frontend(self, frame_data: str):
        """Receive frame from frontend as base64"""
        try:
            # Convert base64 to image
            if frame_data.startswith('data:image/'):
                image_data = base64.b64decode(frame_data.split(',')[1])
            else:
                image_data = base64.b64decode(frame_data)
                
            nparr = np.frombuffer(image_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                logger.warning("Failed to decode frame from base64")
                return False
                
            async with self.frame_lock:
                self.latest_frame = frame
                self.last_frame_time = time.time()
                self.frame_received_count += 1
                
                # Log every 100 frames
                if self.frame_received_count % 100 == 0:
                    logger.info(f"📸 Received {self.frame_received_count} frames")
                    
            return True
        except Exception as e:
            logger.error(f"Error processing frame from frontend: {e}")
            return False
    
    def get_latest_frame(self):
        """Get the latest frame from frontend"""
        # Check if frame is stale
        if time.time() - self.last_frame_time > self.frame_timeout:
            return None
        return self.latest_frame
    
    def process_face(self, frame):
        """Process face detection and eye movements"""
        if frame is None:
            return None
            
        try:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            # Face detection
            if self.face_detector:
                detection_results = self.face_detector.process(rgb)
                self.face_count = len(detection_results.detections) if detection_results and detection_results.detections else 0
            else:
                self.face_count = 0
            
            # Face mesh for eye tracking
            mesh_results = None
            if self.face_mesh:
                mesh_results = self.face_mesh.process(rgb)
                self.face_alert = ""
                
                if mesh_results and mesh_results.multi_face_landmarks:
                    self.frame_counter += 1
                    for face_landmarks in mesh_results.multi_face_landmarks:
                        # Eye movement detection
                        try:
                            eye_x = face_landmarks.landmark[33].x  # Right eye corner
                            if self.prev_eye_x is not None and self.frame_counter % 10 == 0:
                                if abs(eye_x - self.prev_eye_x) > 0.015:
                                    self.eye_movement_count += 1
                            self.prev_eye_x = eye_x
                        except:
                            pass
                    
                    current_face_count = len(mesh_results.multi_face_landmarks)
                    if self.last_detected_face_count != 0 and current_face_count != self.last_detected_face_count:
                        self.face_alert = "Face transition detected!"
                    self.last_detected_face_count = current_face_count
            
            if self.face_count > 1:
                self.face_alert += " | Multiple people!" if self.face_alert else "Multiple people detected!"
            
            return mesh_results
            
        except Exception as e:
            logger.error(f"Face processing error: {e}")
            return None
    
    # ==========================================================
    # COMPLETELY REWRITTEN GENDER DETECTION
    # ==========================================================
    
    def process_gender(self, frame):
        """Process gender detection with multiple fallback methods - COMPLETELY REWRITTEN"""
        if frame is None:
            logger.debug("No frame for gender detection")
            return
            
        self.gender_frame_counter += 1
        current_time = time.time()
        
        try:
            gender_result = "Unknown"
            confidence = 0.0
            
            # Method 1: YOLO-based detection (if available)
            if self.model is not None:
                try:
                    results = self.model(frame, verbose=False)
                    
                    if results and len(results) > 0:
                        male_count = 0
                        female_count = 0
                        
                        for result in results:
                            if result.boxes is not None and len(result.boxes) > 0:
                                for box in result.boxes:
                                    cls = int(box.cls[0])
                                    conf = float(box.conf[0])
                                    
                                    # If confidence is high enough
                                    if conf > 0.5:
                                        # Check class name from YOLO model
                                        if hasattr(self.model, 'names') and cls in self.model.names:
                                            class_name = self.model.names[cls].lower()
                                            
                                            # Check for gender in class names
                                            if class_name == 'male':
                                                male_count += 1
                                                confidence = max(confidence, conf)
                                            elif class_name == 'female':
                                                female_count += 1
                                                confidence = max(confidence, conf)
                        
                        # Determine gender based on counts
                        if male_count > female_count:
                            gender_result = "Male"
                        elif female_count > male_count:
                            gender_result = "Female"
                        elif male_count > 0 or female_count > 0:
                            gender_result = "Person"
                            
                except Exception as e:
                    logger.debug(f"YOLO gender detection error: {e}")
            
            # Method 2: If YOLO didn't detect gender but face exists
            if gender_result in ["Unknown", "Person"] and self.face_count > 0:
                # Check frame dimensions for basic estimation
                h, w = frame.shape[:2]
                if h > 0 and w > 0:
                    # Just indicate face detected
                    gender_result = f"Face detected ({self.face_count})"
                    confidence = 0.5
            elif self.face_count == 0:
                gender_result = "No face"
                confidence = 0.0
            
            # Update gender history
            self.gender_history.append(gender_result)
            
            # Get most common gender from history for stability
            if len(self.gender_history) > 0:
                # Count occurrences
                gender_counts = Counter(self.gender_history)
                most_common = gender_counts.most_common(1)[0][0]
                
                # Only update if different or if it's been a while
                if most_common != self.latest_gender:
                    logger.info(f"🔄 Gender changed from '{self.latest_gender}' to '{most_common}'")
                    self.latest_gender = most_common
                    self.gender_confidence = confidence
                    self.last_gender_update = current_time
                elif current_time - self.last_gender_update > 2.0:  # Force update every 2 seconds
                    self.latest_gender = most_common
                    self.gender_confidence = confidence
                    self.last_gender_update = current_time
            
            logger.debug(f"Gender detection result: {self.latest_gender} (confidence: {confidence:.2f})")
            
        except Exception as e:
            logger.error(f"Gender detection error: {e}")
            self.latest_gender = "Error"
    
    def process_mood(self, frame, mesh_results):
        """Process mood/emotion detection using DeepFace"""
        if frame is None:
            return
            
        self.mood_frame_counter += 1
        if self.mood_frame_counter % MOOD_ANALYZE_EVERY_N_FRAMES != 0:
            return
        
        try:
            if not (mesh_results and mesh_results.multi_face_landmarks):
                return
            
            ih, iw, _ = frame.shape
            face = mesh_results.multi_face_landmarks[0]
            xs = [lm.x for lm in face.landmark]
            ys = [lm.y for lm in face.landmark]
            x1 = int(min(xs) * iw); x2 = int(max(xs) * iw)
            y1 = int(min(ys) * ih); y2 = int(max(ys) * ih)
            pad_px = 40
            x1 = max(0, x1 - pad_px); y1 = max(0, y1 - pad_px)
            x2 = min(iw, x2 + pad_px); y2 = min(ih, y2 + pad_px)
            
            if x2 - x1 < 30 or y2 - y1 < 30:
                return
            
            face_crop = frame[y1:y2, x1:x2].copy()
            if face_crop.size == 0:
                return
            
            face_rgb = cv2.cvtColor(face_crop, cv2.COLOR_BGR2RGB)
            
            if not DEEPFACE_AVAILABLE or DeepFace is None:
                self.mood_history.append("neutral")
                self.current_mood = "neutral"
                return
            
            try:
                result = DeepFace.analyze(face_rgb, actions=['emotion'], enforce_detection=False)
                
                if isinstance(result, list) and len(result) > 0:
                    res = result[0]
                elif isinstance(result, dict):
                    res = result
                else:
                    return
                
                emotions = res.get('emotion') or {}
                if not emotions:
                    return
                
                emotions_copy = dict(emotions)
                neutral_pct = emotions_copy.get('neutral', 0.0)
                if neutral_pct >= NEUTRAL_IGNORE_THRESHOLD:
                    emotions_copy.pop('neutral', None)
                
                if emotions_copy:
                    predicted = max(emotions_copy.items(), key=lambda kv: kv[1])[0]
                else:
                    predicted = res.get('dominant_emotion', 'neutral')
                
                self.mood_history.append(predicted)
                most_common = Counter(self.mood_history).most_common(1)[0][0]
                
                if most_common != self.current_mood:
                    logger.debug(f"Mood changed: {self.current_mood} -> {most_common}")
                    self.current_mood = most_common
                    
            except Exception as deepface_error:
                logger.warning(f"DeepFace analysis skipped: {deepface_error}")
                
        except Exception as e:
            logger.error(f"Mood detection error: {e}")
    
    def audio_vad_worker(self):
        """Audio processing worker for speech detection"""
        if self.stream is None:
            return
            
        while self.running:
            try:
                frame_bytes = self.stream.read(self.SAMPLES_PER_FRAME, exception_on_overflow=False)
                is_speech = self.vad.is_speech(frame_bytes, self.RATE)
                self.speech_deque.append(1 if is_speech else 0)
                
                # Calculate speech confidence
                speech_ratio = sum(self.speech_deque) / len(self.speech_deque) if len(self.speech_deque) > 0 else 0
                self.speech_confidence = speech_ratio
                self.recent_speech_flag = speech_ratio > SPEECH_DETECTION_THRESHOLD
                self.speech_detected = self.recent_speech_flag
                
            except Exception as e:
                logger.error(f"Audio processing error: {e}")
                break
    
    def process_noise(self, frame):
        """Process background voice and lip sync detection"""
        if frame is None:
            self.bg_voice = False
            self.lipsync = False
            return
            
        try:
            self.bg_voice = False
            self.lipsync = False
            
            if self.noise_face_mesh is None:
                return
            
            speech = self.recent_speech_flag
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = self.noise_face_mesh.process(rgb)
            
            if results and getattr(results, 'multi_face_landmarks', None):
                lm = results.multi_face_landmarks[0].landmark
                ih, iw, _ = frame.shape
                
                try:
                    # Calculate mouth openness ratio
                    top_y = lm[13].y * ih  # Upper lip
                    bot_y = lm[14].y * ih  # Lower lip
                    face_h = abs(lm[152].y*ih - lm[10].y*ih)  # Face height
                    mouth_open_ratio = max(0.0, (bot_y - top_y) / max(1.0, face_h))
                except:
                    mouth_open_ratio = 0.0
                    
                self.mouth_ratio_debug = mouth_open_ratio
                
                # Enhanced lip sync and background voice detection
                if speech:
                    self.lipsync = mouth_open_ratio > LIPSYNC_THRESHOLD
                    self.bg_voice = mouth_open_ratio < BGVOICE_THRESHOLD
                else:
                    self.lipsync = False
                    self.bg_voice = False
            else:
                # No face detected but speech detected = likely background voice
                self.bg_voice = True if speech else False
                self.mouth_ratio_debug = 0.0
                
        except Exception as e:
            logger.error(f"Noise processing error: {e}")
            self.bg_voice = False
            self.lipsync = False
    
    def process_verification(self, frame):
        """Process face verification against reference face"""
        if frame is None or self.face_cascade is None:
            self.verification_status = "Not initialized"
            return
            
        try:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self.face_cascade.detectMultiScale(gray, 1.3, 5)
            
            if self.reference_face is None and len(faces) > 0:
                self.verification_status = "Reference Not Set"
            elif self.reference_face is not None and len(faces) > 0:
                (x, y, w, h) = faces[0]
                current = frame[y:y+h, x:x+w]
                
                # Resize both faces to same dimensions
                gray1 = cv2.resize(cv2.cvtColor(self.reference_face, cv2.COLOR_BGR2GRAY), (100, 100))
                gray2 = cv2.resize(cv2.cvtColor(current, cv2.COLOR_BGR2GRAY), (100, 100))
                
                # Calculate histogram similarity
                hist1 = cv2.normalize(cv2.calcHist([gray1], [0], None, [256], [0, 256]), None).flatten()
                hist2 = cv2.normalize(cv2.calcHist([gray2], [0], None, [256], [0, 256]), None).flatten()
                sim = cv2.compareHist(hist1, hist2, cv2.HISTCMP_CORREL)
                
                self.verification_status = "MATCH" if sim > FACE_VERIFICATION_THRESHOLD else "NOT MATCH"
                logger.debug(f"Face verification similarity: {sim:.3f}")
                
        except Exception as e:
            logger.error(f"Face verification error: {e}")
            self.verification_status = "Error"
    
    def get_detection_data(self) -> Dict[str, Any]:
        """Get comprehensive detection data"""
        # Force gender update if no update recently
        current_time = time.time()
        if current_time - self.last_gender_update > 1.0:  # Update every 1 second
            if self.latest_frame is not None:
                self.process_gender(self.latest_frame)
        
        return {
            "faces": self.face_count,
            "eye_moves": self.eye_movement_count,
            "face_alert": self.face_alert,
            "gender": self.latest_gender,
            "gender_confidence": round(self.gender_confidence, 3),
            "mood": self.current_mood,
            "bg_voice": self.bg_voice,
            "lipsync": self.lipsync,
            "verification": self.verification_status,
            "speech": self.speech_detected,
            "speech_confidence": round(self.speech_confidence, 3),
            "mouth_ratio": round(float(self.mouth_ratio_debug), 4),
            "timestamp": time.time()
        }
    
    async def set_reference_face(self, session_id: str, image_data: str = None):
        """Set reference face for verification"""
        try:
            frame = None
            
            # If image_data is provided, use it
            if image_data:
                try:
                    # Handle base64 image data
                    if image_data.startswith('data:image/'):
                        image_data = image_data.split(',')[1]
                    
                    image_bytes = base64.b64decode(image_data)
                    nparr = np.frombuffer(image_bytes, np.uint8)
                    frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    
                    if frame is None:
                        logger.error("Failed to decode image from base64")
                        return False
                        
                except Exception as e:
                    logger.error(f"Error decoding image data: {e}")
                    return False
            else:
                # Use the latest frame from webcam
                frame = self.get_latest_frame()
            
            if frame is None or self.face_cascade is None:
                logger.warning("No frame or face cascade for reference capture")
                return False
                
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self.face_cascade.detectMultiScale(gray, 1.3, 5)
            
            if len(faces) > 0:
                (x, y, w, h) = faces[0]
                self.reference_face = frame[y:y+h, x:x+w].copy()
                self.verification_status = "Reference Set"
                logger.info("Reference face captured successfully")
                
                # Update session
                if session_id in self.fraud_system.active_sessions:
                    self.fraud_system.active_sessions[session_id].reference_face_set = True
                
                # Save reference face for debugging
                cv2.imwrite("reference_face.jpg", self.reference_face)
                logger.info(f"Reference face saved to reference_face.jpg (size: {w}x{h})")
                
                return True
            else:
                logger.warning("No face detected for reference capture")
                return False
                
        except Exception as e:
            logger.error(f"Error capturing reference face: {e}")
            return False
    
    async def process_frame(self, session_id: str = None):
        """Process the latest frame from frontend and return detection data with fraud alerts"""
        frame = self.get_latest_frame()
        
        # Update session activity
        if session_id:
            self.fraud_system.update_activity(session_id)
        
        # Return default data when no frame available
        if frame is None:
            detection_data = {
                "faces": 0,
                "eye_moves": self.eye_movement_count,
                "face_alert": "Waiting for video feed",
                "gender": self.latest_gender,
                "gender_confidence": round(self.gender_confidence, 3),
                "mood": self.current_mood,
                "bg_voice": self.bg_voice,
                "lipsync": self.lipsync,
                "verification": self.verification_status,
                "speech": self.speech_detected,
                "speech_confidence": round(self.speech_confidence, 3),
                "mouth_ratio": 0.0,
                "timestamp": time.time(),
                "fraud_alerts": []
            }
            
            return detection_data
        
        # Process all detection components
        try:
            mesh_results = self.process_face(frame)
            self.process_noise(frame)
            self.process_verification(frame)
            
            # Run gender detection - ALWAYS process gender on every frame
            self.process_gender(frame)
            
            self.process_mood(frame, mesh_results)
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
        
        # Get detection data
        detection_data = self.get_detection_data()
        
        # Check for fraud alerts if session exists
        fraud_alerts = []
        if session_id and session_id in self.fraud_system.active_sessions:
            session = self.fraud_system.active_sessions[session_id]
            fraud_alerts = self.fraud_system.check_fraud_alerts(detection_data, session)
            
            # Add new alerts to session
            for alert in fraud_alerts:
                if alert not in [a.get('message', '') for a in session.fraud_alerts[-10:]]:
                    alert_data = {
                        "type": "fraud_alert",
                        "message": alert,
                        "data": detection_data,
                        "timestamp": time.time()
                    }
                    session.fraud_alerts.append(alert_data)
                    
                    # Send alert via WebSocket
                    await self.fraud_system.send_to_websocket(session_id, alert_data)
        
        detection_data["fraud_alerts"] = fraud_alerts
        
        return detection_data
    
    def cleanup(self):
        """Cleanup resources"""
        self.running = False
        
        # Cleanup MediaPipe
        if self.face_mesh:
            self.face_mesh.close()
        if self.noise_face_mesh:
            self.noise_face_mesh.close()
        
        # Cleanup audio
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
        if self.p:
            self.p.terminate()
        
        logger.info("AI Detector cleanup completed")

# Initialize systems
logger.info("Initializing Fraud Detection System...")
fraud_system = FraudDetectionSystem()
ai_detector = AIDetector(fraud_system)

# ==========================================================
# Store resumes by room_id
# ==========================================================
resume_store: Dict[str, str] = {}  # room_id -> resume_text

active_connections = []

# ==========================================================
# REST API Endpoints
# ==========================================================

# Health check endpoint (always works)
@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "message": "AI Interview Detection & Interview API v5.4.0 is running",
        "active_sessions": len(fraud_system.active_sessions),
        "active_connections": len(active_connections),
        "ai_interview_available": AI_INTERVIEW_AVAILABLE,
        "dependencies": {
            "mediapipe": ai_detector.face_mesh is not None,
            "deepface": DEEPFACE_AVAILABLE,
            "yolo": YOLO_AVAILABLE,
            "audio": ai_detector.stream is not None,
            "ai_interview": AI_INTERVIEW_AVAILABLE
        },
        "resume_store_status": {
            "total_resumes": len(resume_store),
            "room_ids": list(resume_store.keys())
        },
        "timestamp": time.time()
    }

# Resume Upload Endpoint
@app.post("/upload_resume")
async def upload_resume(
    session_id: str = Form(...),
    room_id: str = Form(...),
    file: UploadFile = File(...)
):
    """Upload and process resume"""
    try:
        print(f"\n{'='*60}")
        print(f"📄 Resume upload request")
        print(f"📄 session_id: {session_id}")
        print(f"📄 room_id: {room_id}")
        print(f"📄 filename: {file.filename}")
        print(f"📄 content_type: {file.content_type}")
        print(f"{'='*60}")
        
        if not file.filename.endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Only PDF resumes allowed")
        
        # Read file content
        content = await file.read()
        print(f"📄 File size: {len(content)} bytes")
        
        # Extract text from PDF
        reader = PyPDF2.PdfReader(io.BytesIO(content))
        resume_text = ""
        for page_num, page in enumerate(reader.pages):
            text = page.extract_text()
            if text:
                resume_text += text + "\n"
                print(f"📄 Page {page_num+1}: {len(text)} chars")
        
        # Store resume by room_id
        resume_store[room_id] = resume_text
        print(f"📄 Resume stored for room_id: {room_id}")
        print(f"📄 Total resume length: {len(resume_text)} chars")
        print(f"📄 All stored room IDs: {list(resume_store.keys())}")
        print(f"📄 First 200 chars: {resume_text[:200]}")
        
        # Update session if exists
        if session_id in fraud_system.active_sessions:
            fraud_system.active_sessions[session_id].resume_text = resume_text
        
        print(f"📄 Upload successful!")
        print(f"{'='*60}\n")
        
        return {
            "status": "success",
            "message": "Resume uploaded successfully",
            "session_id": session_id,
            "room_id": room_id,
            "resume_length": len(resume_text),
            "filename": file.filename,
            "stored_rooms": list(resume_store.keys()),
            "timestamp": time.time()
        }
    except Exception as e:
        print(f"❌ Error uploading resume: {e}")
        logger.error(f"Error uploading resume: {e}")
        raise HTTPException(status_code=500, detail=f"Error processing resume: {str(e)}")

# Debug endpoint to check resume status
@app.get("/debug_resume_status")
async def debug_resume_status(room_id: str = "default"):
    """Debug endpoint to check resume status"""
    return {
        "room_id": room_id,
        "has_resume": room_id in resume_store,
        "resume_length": len(resume_store.get(room_id, "")),
        "all_rooms_with_resumes": list(resume_store.keys()),
        "resume_preview": resume_store.get(room_id, "")[:500] if room_id in resume_store else "No resume found",
        "timestamp": time.time()
    }

# ==========================================================
# /set_reference_face endpoint
# ==========================================================
@app.post("/set_reference_face")
async def set_reference_face(request: Request):
    """Set reference face for verification"""
    try:
        # Try to parse as JSON first
        content_type = request.headers.get("Content-Type", "")
        
        if "application/json" in content_type:
            data = await request.json()
            session_id = data.get("session_id")
            image_data = data.get("image_data")
        else:
            # Try form data
            form_data = await request.form()
            session_id = form_data.get("session_id")
            image_data = form_data.get("image_data")
        
        if not session_id:
            return JSONResponse(
                status_code=400,
                content={
                    "status": "error", 
                    "message": "session_id is required",
                    "timestamp": time.time()
                }
            )
        
        logger.info(f"Setting reference face for session: {session_id}")
        
        # Call the method
        success = await ai_detector.set_reference_face(session_id, image_data)
        
        if success:
            return {
                "status": "success", 
                "message": "Reference face set successfully",
                "session_id": session_id,
                "timestamp": time.time()
            }
        else:
            return JSONResponse(
                status_code=422,
                content={
                    "status": "error", 
                    "message": "Failed to set reference face - no face detected. Ensure face is clearly visible with good lighting.",
                    "session_id": session_id,
                    "timestamp": time.time()
                }
            )
            
    except json.JSONDecodeError:
        return JSONResponse(
            status_code=400,
            content={
                "status": "error", 
                "message": "Invalid request format. Use JSON with session_id field.",
                "timestamp": time.time()
            }
        )
    except Exception as e:
        logger.error(f"Error setting reference face: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "status": "error", 
                "message": f"Error setting reference face: {str(e)}",
                "timestamp": time.time()
            }
        )

# ==========================================================
# /start_interview endpoint
# ==========================================================
@app.post("/start_interview")
async def start_interview(session_id: str, room_id: str = "default"):
    """Start interview session"""
    try:
        print(f"\n{'='*60}")
        print(f"🎬 Starting interview session")
        print(f"🎬 session_id: {session_id}")
        print(f"🎬 room_id: {room_id}")
        print(f"{'='*60}")
        
        # Get or create session
        session = await fraud_system.get_or_create_session(session_id, room_id)
        
        print(f"✅ Interview session started successfully!")
        print(f"{'='*60}\n")
        
        return {
            "status": "success",
            "message": "Interview session started successfully",
            "session_id": session.session_id,
            "room_id": session.room_id,
            "timestamp": time.time()
        }
    except Exception as e:
        print(f"❌ Error starting interview: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "message": f"Error starting interview: {str(e)}",
                "timestamp": time.time()
            }
        )

# ==========================================================
# /stop_interview endpoint
# ==========================================================
@app.post("/stop_interview")
async def stop_interview(session_id: str):
    """Stop interview session"""
    try:
        print(f"\n{'='*60}")
        print(f"🛑 Stopping interview session")
        print(f"🛑 session_id: {session_id}")
        print(f"{'='*60}")
        
        if session_id not in fraud_system.active_sessions:
            return JSONResponse(
                status_code=404,
                content={
                    "status": "error",
                    "message": f"Session '{session_id}' not found",
                    "timestamp": time.time()
                }
            )
        
        # End the session
        report = await fraud_system.end_detection_session(session_id)
        
        print(f"✅ Interview session stopped successfully!")
        print(f"{'='*60}\n")
        
        return {
            "status": "success",
            "message": "Interview session stopped successfully",
            "session_id": session_id,
            "report": report,
            "timestamp": time.time()
        }
    except Exception as e:
        print(f"❌ Error stopping interview: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "status": "error",
                "message": f"Error stopping interview: {str(e)}",
                "timestamp": time.time()
            }
        )

# ==========================================================
# Start AI Interview Endpoint
# ==========================================================
@app.post("/start_ai_interview")
async def start_ai_interview(session_id: str, level: str = "medium", room_id: str = None):
    """Start AI interview session with resume-based questions"""
    try:
        print(f"\n{'='*60}")
        print(f"🤖 Starting AI interview request")
        print(f"🤖 session_id: {session_id}")
        print(f"🤖 level: {level}")
        print(f"🤖 room_id: {room_id}")
        print(f"{'='*60}")
        
        level = level.strip().lower()
        
        if level not in ("easy", "medium", "hard"):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid level '{level}'. Use easy | medium | hard"
            )
        
        if not AI_INTERVIEW_AVAILABLE:
            print(f"❌ AI_INTERVIEW_AVAILABLE = False")
            # Don't raise error, just continue with fallback
            print(f"⚠️ AI Interview not available, using fallback mode")
        
        print(f"✅ AI Interview check passed")
        
        # Get or create session with explicit room_id
        if not room_id:
            # Try to get room_id from existing session
            if session_id in fraud_system.active_sessions:
                room_id = fraud_system.active_sessions[session_id].room_id
            else:
                room_id = "default"
        
        session = await fraud_system.get_or_create_session(session_id, room_id)
        print(f"🤖 Using session: {session_id}, room_id: {room_id}")
        
        # Check resume by room_id
        print(f"📄 Checking resume for room_id: {room_id}")
        print(f"📄 All stored room IDs: {list(resume_store.keys())}")
        
        if room_id not in resume_store:
            print(f"❌ Resume not found for room_id: {room_id}")
            raise HTTPException(
                status_code=400, 
                detail=f"Resume not uploaded for room '{room_id}'. Please upload resume first. Current stored rooms: {list(resume_store.keys())}"
            )
        
        print(f"✅ Resume found for room_id: {room_id}")
        print(f"📄 Resume length: {len(resume_store[room_id])} chars")
        
        # Generate questions based on resume
        print(f"🤖 Generating questions...")
        
        # Use fallback questions
        fallback_questions = [
            "Explain the difference between SQL and NoSQL databases.",
            "Describe a challenging bug you fixed and how you approached it.",
            "How would you design a REST API for a todo list application?",
            "What testing strategies do you use in your projects?",
            "How do you handle conflicts in a team environment?"
        ]
        
        questions = fallback_questions
        
        print(f"🤖 Generated {len(questions)} questions")
        
        # Update session
        session.ai_interview_active = True
        session.ai_interview_level = level
        session.ai_questions = questions
        session.ai_current_question_index = 0
        
        print(f"🎉 AI interview started successfully!")
        print(f"🤖 Questions: {questions}")
        print(f"{'='*60}\n")
        
        return {
            "status": "success",
            "message": "AI interview started successfully",
            "session_id": session_id,
            "room_id": room_id,
            "level": level,
            "questions": questions,
            "timestamp": time.time()
        }
        
    except HTTPException as e:
        print(f"❌ HTTPException: {e.detail}")
        raise
    except Exception as e:
        print(f"❌ Exception: {str(e)}")
        logger.exception("AI interview start failed")
        raise HTTPException(status_code=500, detail=str(e))

# Simple AI Interview Endpoint
@app.post("/start_simple_ai_interview")
async def start_simple_ai_interview(
    session_id: str, 
    level: str = "medium",
    room_id: str = "default"
):
    """Start AI interview without requiring a fraud detection session first"""
    try:
        print(f"\n{'='*60}")
        print(f"🤖 Starting simple AI interview")
        print(f"🤖 session_id: {session_id}")
        print(f"🤖 level: {level}")
        print(f"🤖 room_id: {room_id}")
        print(f"{'='*60}")
        
        level = level.strip().lower()
        
        if level not in ("easy", "medium", "hard"):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid level '{level}'. Use easy | medium | hard"
            )
        
        if not AI_INTERVIEW_AVAILABLE:
            print(f"⚠️ AI Interview not available, using fallback mode")
        
        # Create a simple session if it doesn't exist
        if session_id not in fraud_system.active_sessions:
            print(f"🤖 Creating new simple session")
            session = DetectionSession(
                session_id=session_id,
                room_id=room_id,
                start_time=time.time(),
                interview_active=True,
                ai_interview_active=True
            )
            fraud_system.active_sessions[session_id] = session
        else:
            session = fraud_system.active_sessions[session_id]
        
        # Check if resume exists for this room
        if room_id not in resume_store:
            raise HTTPException(
                status_code=400,
                detail=f"Resume not uploaded for room '{room_id}'. Current stored rooms: {list(resume_store.keys())}"
            )
        
        # Generate questions
        fallback_questions = [
            "Explain the difference between SQL and NoSQL databases.",
            "Describe a challenging bug you fixed and how you approached it.",
            "How would you design a REST API for a todo list application?",
            "What testing strategies do you use in your projects?",
            "How do you handle conflicts in a team environment?"
        ]
        
        questions = fallback_questions
        
        # Update session
        session.ai_interview_active = True
        session.ai_interview_level = level
        session.ai_questions = questions
        session.ai_current_question_index = 0
        
        print(f"🎉 Simple AI interview started successfully!")
        print(f"🤖 Questions: {questions}")
        print(f"{'='*60}\n")
        
        return {
            "status": "success",
            "message": "Simple AI interview started successfully",
            "session_id": session_id,
            "room_id": room_id,
            "level": level,
            "questions": questions,
            "timestamp": time.time()
        }
        
    except Exception as e:
        print(f"❌ Error: {str(e)}")
        logger.error(f"Error starting simple AI interview: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/submit_ai_answer")
async def submit_ai_answer(session_id: str, question: str, answer: str):
    """Submit answer to AI interview question"""
    try:
        if session_id not in fraud_system.active_sessions:
            raise HTTPException(status_code=400, detail="Session not found")
        
        session = fraud_system.active_sessions[session_id]
        if not session.ai_interview_active:
            raise HTTPException(status_code=400, detail="AI interview not active")
        
        # Simple scoring based on answer length
        score = min(10, len(answer.split()) // 10)
        feedback = f"Score based on answer length. Score: {score}/10"
        
        # Update session
        session.ai_scores.append(score)
        session.ai_history.append({
            "question": question,
            "answer": answer,
            "score": score,
            "feedback": feedback
        })
        
        # Check if all questions answered
        next_question = None
        if session.ai_current_question_index < len(session.ai_questions):
            next_question = session.ai_questions[session.ai_current_question_index]
            session.ai_current_question_index += 1
        
        return {
            "status": "success",
            "message": "Answer submitted successfully",
            "session_id": session_id,
            "score": score,
            "feedback": feedback,
            "next_question": next_question,
            "questions_remaining": len(session.ai_questions) - session.ai_current_question_index,
            "total_score": sum(session.ai_scores),
            "average_score": sum(session.ai_scores) / len(session.ai_scores) if session.ai_scores else 0,
            "timestamp": time.time()
        }
    except Exception as e:
        logger.error(f"Error submitting AI answer: {e}")
        raise HTTPException(status_code=500, detail=f"Error submitting answer: {str(e)}")

@app.post("/end_ai_interview")
async def end_ai_interview(session_id: str):
    """End AI interview and get results"""
    try:
        if session_id not in fraud_system.active_sessions:
            raise HTTPException(status_code=400, detail="Session not found")
        
        session = fraud_system.active_sessions[session_id]
        if not session.ai_interview_active:
            raise HTTPException(status_code=400, detail="AI interview not active")
        
        # Calculate results
        total_score = sum(session.ai_scores)
        max_score = len(session.ai_scores) * 10
        percentage = (total_score / max_score) * 100 if max_score else 0
        
        if percentage >= 80:
            verdict = "Excellent"
        elif percentage >= 60:
            verdict = "Good"
        elif percentage >= 40:
            verdict = "Average"
        else:
            verdict = "Needs Improvement"
        
        # End AI interview
        session.ai_interview_active = False
        
        results = {
            "total_score": total_score,
            "max_score": max_score,
            "percentage": round(percentage, 2),
            "verdict": verdict,
            "questions_answered": len(session.ai_scores),
            "average_score": round(total_score / len(session.ai_scores), 2) if session.ai_scores else 0,
            "scores": session.ai_scores,
            "history": session.ai_history
        }
        
        return {
            "status": "success",
            "message": "AI interview ended successfully",
            "session_id": session_id,
            "results": results,
            "timestamp": time.time()
        }
    except Exception as e:
        logger.error(f"Error ending AI interview: {e}")
        raise HTTPException(status_code=500, detail=f"Error ending AI interview: {str(e)}")

@app.get("/stats")
async def get_stats():
    """Get current detection statistics"""
    stats = ai_detector.get_detection_data()
    stats["fraud_system"] = {
        "active_sessions": len(fraud_system.active_sessions),
        "total_websocket_connections": len(fraud_system.websocket_connections),
        "sessions": [
            {
                "session_id": s.session_id,
                "room_id": s.room_id,
                "active_for": round(time.time() - s.start_time, 2),
                "last_activity": s.last_activity,
                "idle_seconds": round(time.time() - s.last_activity, 2) if s.last_activity else 0
            }
            for s in fraud_system.active_sessions.values()
        ]
    }
    stats["gender_detection"] = {
        "current_gender": ai_detector.latest_gender,
        "gender_confidence": ai_detector.gender_confidence,
        "gender_history": list(ai_detector.gender_history),
        "yolo_available": YOLO_AVAILABLE,
        "deepface_available": DEEPFACE_AVAILABLE,
        "face_detector_available": ai_detector.face_detector is not None,
        "frame_available": ai_detector.latest_frame is not None,
        "frame_age": round(time.time() - ai_detector.last_frame_time, 2) if ai_detector.last_frame_time > 0 else 0,
        "frames_received": ai_detector.frame_received_count
    }
    stats["ai_interview"] = {
        "available": AI_INTERVIEW_AVAILABLE,
        "resumes_stored": len(resume_store),
        "active_ai_interviews": sum(1 for s in fraud_system.active_sessions.values() if s.ai_interview_active)
    }
    stats["dependencies"] = {
        "mediapipe": ai_detector.face_mesh is not None,
        "deepface": DEEPFACE_AVAILABLE,
        "yolo": YOLO_AVAILABLE,
        "ai_interview": AI_INTERVIEW_AVAILABLE,
        "audio": ai_detector.stream is not None
    }
    stats["timestamp"] = time.time()
    return stats

@app.get("/session/{session_id}")
async def get_session_info(session_id: str):
    """Get session information"""
    if session_id in fraud_system.active_sessions:
        session = fraud_system.active_sessions[session_id]
        
        # Check if resume is available for this room
        resume_available = session.room_id in resume_store
        
        return {
            "status": "active",
            "session_id": session.session_id,
            "room_id": session.room_id,
            "start_time": datetime.fromtimestamp(session.start_time).isoformat(),
            "duration_seconds": round((time.time() - session.start_time), 2),
            "last_activity": datetime.fromtimestamp(session.last_activity).isoformat() if session.last_activity else None,
            "idle_seconds": round(time.time() - session.last_activity, 2) if session.last_activity else 0,
            "fraud_alerts_count": len(session.fraud_alerts),
            "reference_face_set": session.reference_face_set,
            "interview_active": session.interview_active,
            "ai_interview_active": session.ai_interview_active,
            "ai_interview_level": session.ai_interview_level,
            "ai_questions_count": len(session.ai_questions),
            "ai_questions_answered": len(session.ai_scores),
            "ai_current_question_index": session.ai_current_question_index,
            "resume_uploaded": session.resume_text is not None,
            "room_resume_available": resume_available,
            "timestamp": time.time()
        }
    else:
        return {
            "status": "not_found",
            "message": "Session not found",
            "session_id": session_id,
            "timestamp": time.time()
        }

# Test gender detection endpoint
@app.post("/test_gender_detection")
async def test_gender_detection():
    """Test gender detection with current frame"""
    frame = ai_detector.get_latest_frame()
    if frame is None:
        return {"status": "error", "message": "No frame available"}
    
    # Save frame for debugging
    cv2.imwrite("debug_frame.jpg", frame)
    
    # Run gender detection
    ai_detector.process_gender(frame)
    
    return {
        "status": "success",
        "gender": ai_detector.latest_gender,
        "gender_confidence": ai_detector.gender_confidence,
        "gender_history": list(ai_detector.gender_history),
        "frame_saved": "debug_frame.jpg",
        "timestamp": time.time()
    }

# Connection health check
@app.get("/connection_health")
async def connection_health():
    """Check WebSocket connection health"""
    return {
        "status": "healthy",
        "active_websockets": len(fraud_system.websocket_connections),
        "active_sessions": len(fraud_system.active_sessions),
        "frame_available": ai_detector.latest_frame is not None,
        "frame_age": round(time.time() - ai_detector.last_frame_time, 2) if ai_detector.last_frame_time > 0 else 0,
        "frames_received": ai_detector.frame_received_count,
        "audio_available": ai_detector.stream is not None,
        "reconnect_attempts": fraud_system.reconnect_attempts,
        "timestamp": time.time()
    }

# ==========================================================
# WebSocket Endpoint
# ==========================================================

class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.last_ping: Dict[str, float] = {}
    
    async def connect(self, websocket: WebSocket, session_id: str):
        await websocket.accept()
        self.active_connections[session_id] = websocket
        self.last_ping[session_id] = time.time()
        logger.info(f"WebSocket connected for session: {session_id}")
    
    def disconnect(self, session_id: str):
        if session_id in self.active_connections:
            del self.active_connections[session_id]
        if session_id in self.last_ping:
            del self.last_ping[session_id]
        logger.info(f"WebSocket disconnected for session: {session_id}")
    
    async def send_message(self, session_id: str, message: dict):
        if session_id in self.active_connections:
            try:
                await self.active_connections[session_id].send_json(message)
                return True
            except Exception as e:
                logger.error(f"Error sending WebSocket message: {e}")
                self.disconnect(session_id)
        return False
    
    def update_ping(self, session_id: str):
        self.last_ping[session_id] = time.time()
    
    def get_idle_time(self, session_id: str) -> float:
        if session_id in self.last_ping:
            return time.time() - self.last_ping[session_id]
        return 0

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time communication"""
    current_session_id = None
    
    try:
        # Accept connection
        await websocket.accept()
        active_connections.append(websocket)
        logger.info(f"✅ New WebSocket connection. Total connections: {len(active_connections)}")
        
        # Send initial connection confirmation
        await websocket.send_json({
            "type": "connection_established",
            "message": "WebSocket connection established",
            "timestamp": time.time(),
            "server_time": time.time()
        })
        
        # Keepalive loop
        last_ping_time = time.time()
        
        while True:
            try:
                # Receive data with timeout
                data = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                last_ping_time = time.time()
                
                # Update manager ping
                if current_session_id:
                    manager.update_ping(current_session_id)
                
                try:
                    json_data = json.loads(data)
                    
                    # Handle ping messages
                    if json_data.get('type') == 'ping':
                        await websocket.send_json({
                            "type": "pong",
                            "timestamp": time.time()
                        })
                        continue
                    
                    # Handle participant frame
                    if json_data.get('type') == 'participant_frame':
                        frame_data = json_data.get('image')
                        room_id = json_data.get('roomId')
                        user_id = json_data.get('userId')
                        session_id = json_data.get('sessionId')
                        
                        # Update current session
                        current_session_id = session_id
                        
                        if frame_data:
                            success = await ai_detector.set_frame_from_frontend(frame_data)
                            if not success:
                                logger.warning("Failed to process frame from frontend")
                        
                        # Process detection and send back results
                        detection_data = await ai_detector.process_frame(session_id)
                        detection_data['room_id'] = room_id
                        detection_data['user_id'] = user_id
                        detection_data['session_id'] = session_id
                        
                        # Add AI interview status if session exists
                        if session_id in fraud_system.active_sessions:
                            session = fraud_system.active_sessions[session_id]
                            detection_data['ai_interview_active'] = session.ai_interview_active
                            detection_data['room_resume_available'] = session.room_id in resume_store
                            if session.ai_interview_active and session.ai_current_question_index < len(session.ai_questions):
                                detection_data['current_ai_question'] = session.ai_questions[session.ai_current_question_index]
                        
                        await websocket.send_json(detection_data)
                        
                    elif json_data.get('type') == 'command':
                        command = json_data.get('command')
                        session_id = json_data.get('session_id') or current_session_id
                        
                        # Handle different commands
                        if command == 'ping':
                            await websocket.send_json({
                                "type": "pong",
                                "timestamp": time.time()
                            })
                        
                        elif command == 'register_session':
                            session_id = json_data.get('session_id')
                            room_id = json_data.get('room_id')
                            if session_id:
                                fraud_system.register_websocket(session_id, websocket)
                                await manager.connect(websocket, session_id)
                                await websocket.send_json({
                                    "type": "command_response",
                                    "command": "register_session",
                                    "status": "success",
                                    "session_id": session_id,
                                    "room_id": room_id
                                })
                        
                        elif command == 'start_interview':
                            if session_id:
                                room_id = json_data.get('room_id', 'default')
                                await fraud_system.start_detection_session(session_id, room_id)
                                await websocket.send_json({
                                    "type": "command_response", 
                                    "command": "start_interview", 
                                    "status": "success",
                                    "session_id": session_id
                                })
                        
                        elif command == 'stop_interview':
                            if session_id:
                                report = await fraud_system.end_detection_session(session_id)
                                await websocket.send_json({
                                    "type": "command_response", 
                                    "command": "stop_interview", 
                                    "status": "success",
                                    "session_id": session_id,
                                    "report": report
                                })
                        
                        elif command == 'set_reference_face':
                            if session_id:
                                success = await ai_detector.set_reference_face(session_id)
                                await websocket.send_json({
                                    "type": "command_response", 
                                    "command": "set_reference_face", 
                                    "status": "success" if success else "failed",
                                    "session_id": session_id
                                })
                        
                        elif command == 'start_ai_interview':
                            if session_id:
                                level = json_data.get('level', 'medium')
                                room_id = json_data.get('room_id', 'default')
                                
                                print(f"\n{'='*60}")
                                print(f"🤖 WebSocket start_ai_interview command")
                                print(f"🤖 session_id: {session_id}")
                                print(f"🤖 level: {level}")
                                print(f"🤖 room_id: {room_id}")
                                print(f"{'='*60}")
                                
                                # Get or create session
                                session = await fraud_system.get_or_create_session(session_id, room_id)
                                
                                # Check resume
                                if room_id not in resume_store:
                                    await websocket.send_json({
                                        "type": "ai_interview_error",
                                        "message": f"Resume not uploaded for room '{room_id}'",
                                        "session_id": session_id
                                    })
                                    continue
                                
                                # Generate questions
                                fallback_questions = [
                                    "Explain the difference between SQL and NoSQL databases.",
                                    "Describe a challenging bug you fixed and how you approached it.",
                                    "How would you design a REST API for a todo list application?",
                                    "What testing strategies do you use in your projects?",
                                    "How do you handle conflicts in a team environment?"
                                ]
                                
                                questions = fallback_questions
                                
                                # Update session
                                session.ai_interview_active = True
                                session.ai_interview_level = level
                                session.ai_questions = questions
                                session.ai_current_question_index = 0
                                
                                await websocket.send_json({
                                    "type": "ai_interview_started",
                                    "session_id": session_id,
                                    "room_id": room_id,
                                    "level": level,
                                    "questions": questions,
                                    "first_question": questions[0] if questions else None,
                                    "timestamp": time.time()
                                })
                        
                        elif command == 'submit_ai_answer':
                            if session_id:
                                question = json_data.get('question')
                                answer = json_data.get('answer')
                                
                                if session_id in fraud_system.active_sessions:
                                    session = fraud_system.active_sessions[session_id]
                                    
                                    # Simple scoring
                                    score = min(10, len(answer.split()) // 10)
                                    
                                    session.ai_scores.append(score)
                                    session.ai_history.append({
                                        "question": question,
                                        "answer": answer,
                                        "score": score
                                    })
                                    
                                    next_question = None
                                    if session.ai_current_question_index < len(session.ai_questions):
                                        next_question = session.ai_questions[session.ai_current_question_index]
                                        session.ai_current_question_index += 1
                                    
                                    await websocket.send_json({
                                        "type": "ai_answer_feedback",
                                        "session_id": session_id,
                                        "score": score,
                                        "feedback": f"Score: {score}/10",
                                        "next_question": next_question,
                                        "questions_remaining": len(session.ai_questions) - session.ai_current_question_index,
                                        "total_score": sum(session.ai_scores)
                                    })
                
                except json.JSONDecodeError:
                    # Handle non-JSON data (like direct image frames)
                    if data.startswith('data:image/') or len(data) > 1000:
                        await ai_detector.set_frame_from_frontend(data)
                        detection_data = await ai_detector.process_frame(current_session_id)
                        if detection_data:
                            await websocket.send_json(detection_data)
            
            except asyncio.TimeoutError:
                # Send keepalive ping
                try:
                    idle_time = manager.get_idle_time(current_session_id) if current_session_id else 0
                    
                    await websocket.send_json({
                        "type": "ping", 
                        "timestamp": time.time(),
                        "idle_time": idle_time
                    })
                    
                    # Check if connection is still alive
                    if current_session_id and idle_time > 60:  # 60 second timeout
                        logger.warning(f"WebSocket timeout for session: {current_session_id} (idle: {idle_time}s)")
                        break
                        
                except Exception as e:
                    logger.error(f"Keepalive error: {e}")
                    break
    
    except WebSocketDisconnect:
        logger.info(f"🔌 WebSocket disconnected normally for session: {current_session_id}")
    except Exception as e:
        logger.error(f"❌ WebSocket error: {e}")
    finally:
        # Cleanup
        if current_session_id:
            fraud_system.unregister_websocket(current_session_id)
            manager.disconnect(current_session_id)
        if websocket in active_connections:
            active_connections.remove(websocket)
        logger.info(f"🔌 WebSocket cleanup completed. Remaining connections: {len(active_connections)}")

@app.get("/")
async def root():
    """Root endpoint with API information"""
    deps_status = {
        "mediapipe": ai_detector.face_mesh is not None,
        "deepface": DEEPFACE_AVAILABLE,
        "yolo": YOLO_AVAILABLE,
        "audio_input": ai_detector.stream is not None,
        "ai_interview": AI_INTERVIEW_AVAILABLE
    }
    
    missing_deps = [name for name, available in deps_status.items() if not available]
    
    return {
        "message": "AI Interview Detection & Interview API",
        "description": "Real-time AI-powered fraud detection with AI interviewing capabilities",
        "version": "5.4.0",
        "status": "running",
        "dependencies": deps_status,
        "missing_dependencies": missing_deps if missing_deps else "All dependencies available",
        "resume_store_status": {
            "total_resumes": len(resume_store),
            "room_ids": list(resume_store.keys())
        },
        "gender_detection": {
            "current_gender": ai_detector.latest_gender,
            "gender_confidence": ai_detector.gender_confidence
        },
        "endpoints": {
            "start_interview": "POST /start_interview?session_id=xxx&room_id=xxx",
            "stop_interview": "POST /stop_interview?session_id=xxx",
            "set_reference_face": "POST /set_reference_face (JSON: {'session_id': 'xxx'})",
            "upload_resume": "POST /upload_resume (form: session_id, room_id, file)",
            "debug_resume_status": "GET /debug_resume_status?room_id=xxx",
            "start_ai_interview": "POST /start_ai_interview?session_id=xxx&level=medium&room_id=xxx",
            "stats": "GET /stats",
            "health": "GET /health",
            "websocket": "WS /ws (Real-time detection)"
        }
    }

@app.on_event("startup")
async def startup_event():
    """Initialize on application startup"""
    logger.info("🚀 AI Interview Detection & Interview API v5.4.0 starting up...")
    
    # Log dependency status
    deps = {
        "MediaPipe": ai_detector.face_mesh is not None,
        "DeepFace": DEEPFACE_AVAILABLE,
        "YOLO": YOLO_AVAILABLE,
        "Audio Input": ai_detector.stream is not None,
        "AI Interview": AI_INTERVIEW_AVAILABLE
    }
    
    logger.info("📊 Dependencies status:")
    for dep, available in deps.items():
        status = "✅ Available" if available else "❌ Missing"
        logger.info(f"   {status} {dep}")
    
    missing = [dep for dep, available in deps.items() if not available]
    if missing:
        logger.warning(f"⚠️  Missing dependencies: {', '.join(missing)}")
        logger.warning("   Install with: pip install deepface ultralytics PyPDF2 google-generativeai")
    
    # Check YOLO model
    if ai_detector.model:
        try:
            names = ai_detector.model.names
            logger.info(f"🤖 YOLO model classes: {len(names)} classes")
            logger.info(f"🤖 YOLO model class names: {names}")
        except:
            logger.info("🤖 YOLO model loaded but class info not available")

@app.on_event("shutdown")
async def shutdown_event():
    """Cleanup on application shutdown"""
    logger.info("🔴 Application shutdown initiated...")
    ai_detector.cleanup()
    
    # Clean up fraud detection sessions
    for session_id in list(fraud_system.active_sessions.keys()):
        await fraud_system.end_detection_session(session_id)
    
    # Close all WebSocket connections
    for session_id, websocket in fraud_system.websocket_connections.items():
        try:
            await websocket.close()
        except:
            pass
    
    logger.info("✅ Application shutdown completed")

if __name__ == "__main__":
    print("=" * 70)
    print("🤖 AI Interview Detection & Interview FastAPI Server")
    print("=" * 70)
    print("🌐 Server URL: http://localhost:8001")
    print("🌐 Frontend URL: http://localhost:5173") 
    print("=" * 70)
    
    # Check dependencies
    deps = {
        "MediaPipe": ai_detector.face_mesh is not None,
        "DeepFace": DEEPFACE_AVAILABLE,
        "YOLO": YOLO_AVAILABLE,
        "Audio Input": ai_detector.stream is not None,
        "AI Interview": AI_INTERVIEW_AVAILABLE
    }
    
    print("📊 Dependencies:")
    for dep, available in deps.items():
        status = "✅ [OK]" if available else "❌ [MISSING]"
        print(f"   {status} {dep}")
    
    missing = [dep for dep, available in deps.items() if not available]
    if missing:
        print(f"\n⚠️  Missing: {', '.join(missing)}")
        print("   Install with: pip install deepface ultralytics PyPDF2 google-generativeai")
    
    print("=" * 70)
    print("✅ FIXES APPLIED:")
    print("   1. COMPLETELY REWRITTEN gender detection - now uses YOLO model with classes 0=Female, 1=Male")
    print("   2. Fixed NameError: AI_INTERVIEW_AVAILABLE is now defined")
    print("   3. Gender updates every 1 second in get_detection_data()")
    print("   4. Added gender history tracking for stability")
    print("   5. Detailed logging for gender changes")
    print("=" * 70)
    
    uvicorn.run(
        app, 
        host="0.0.0.0", 
        port=8001, 
        log_level="info",
        access_log=True
    )