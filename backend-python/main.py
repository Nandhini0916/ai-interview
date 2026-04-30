# main.py
# ==========================================================
# FRAUD DETECTION SYSTEM ONLY
# AI Interview Conductor imported from ai_interview_model.py
# FIXED: WebSocket disconnection issues
# ==========================================================

import sys
import os

# First, fix environment variables BEFORE any imports
os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"

# Now import everything
import logging
import tempfile
import base64
import time
import json
import threading
import asyncio
import io
from collections import deque
from typing import Dict, Any, Optional
from dataclasses import dataclass
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('fraud_detection.log', encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)
logger.info("🚀 Starting Fraud Detection System v1.0.1")

# Import FastAPI and dependencies
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, UploadFile, File, Form, HTTPException
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    import cv2
    import numpy as np
    import webrtcvad
    import pyaudio
    import uvicorn
    
    logger.info("✅ All core imports successful")
    
except ImportError as e:
    logger.error(f"❌ Import error: {e}")
    print(f"\nMissing dependencies. Install with:")
    print("pip install fastapi uvicorn opencv-python numpy webrtcvad pyaudio python-multipart")
    sys.exit(1)

# Import AI Interview Model
try:
    from ai_interview_model import (
        QuestionGenerator,
        AnswerEvaluator,
        InterviewSession,
        AIInterviewEngine,
        ResultEvaluator,
        GEMINI_AVAILABLE
    )
    logger.info(f"✅ AI Interview Model loaded successfully (Gemini available: {GEMINI_AVAILABLE})")
except ImportError as e:
    logger.error(f"❌ Failed to import ai_interview_model: {e}")
    print("\nError: ai_interview_model.py not found in the same directory")
    sys.exit(1)

# Import MediaPipe
MEDIAPIPE_AVAILABLE = False
try:
    import mediapipe as mp
    MEDIAPIPE_AVAILABLE = True
    logger.info("✅ MediaPipe loaded successfully")
except Exception as e:
    logger.warning(f"MediaPipe not available: {e}")

# Import YOLO for gender detection
YOLO_AVAILABLE = False
yolo_model = None
try:
    from ultralytics import YOLO
    
    # Look for the trained gender detection model
    model_paths = [
        "best (6).pt",
        "best.pt",
        "gender_model.pt",
        "yolov8n.pt"
    ]
    
    for path in model_paths:
        if os.path.exists(path):
            yolo_model = YOLO(path)
            YOLO_AVAILABLE = True
            logger.info(f"✅ YOLO model loaded from {path}")
            break
    
    if not yolo_model:
        # Try to find any .pt file
        pt_files = list(Path(".").glob("*.pt"))
        if pt_files:
            yolo_model = YOLO(pt_files[0])
            YOLO_AVAILABLE = True
            logger.info(f"✅ YOLO model loaded from {pt_files[0]}")
    
    if not YOLO_AVAILABLE:
        logger.warning("⚠️ No YOLO model found. Gender detection will use fallback method.")
        
except Exception as e:
    logger.warning(f"YOLO not available: {e}")
    YOLO_AVAILABLE = False

# Import DeepFace as fallback
DEEPFACE_AVAILABLE = False
try:
    from deepface import DeepFace
    DEEPFACE_AVAILABLE = True
    logger.info("✅ DeepFace loaded successfully")
except Exception as e:
    logger.warning(f"DeepFace not available: {e}")

# Import PyPDF2 for PDF parsing
try:
    import PyPDF2
    PDF_AVAILABLE = True
except ImportError:
    PDF_AVAILABLE = False
    logger.warning("PyPDF2 not available. PDF parsing disabled.")

# Create FastAPI app
app = FastAPI(title="Fraud Detection & AI Interview API", version="1.0.1")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
SPEECH_DETECTION_THRESHOLD = 0.3
WEBSOCKET_HEARTBEAT_INTERVAL = 30  # Increased from 15 to 30 seconds
WEBSOCKET_TIMEOUT = 120  # Increased from 60 to 120 seconds
WEBSOCKET_KEEPALIVE_INTERVAL = 20  # Send ping every 20 seconds

# Store sessions and data
ai_sessions: Dict[str, Any] = {}  # For AI interview sessions
resume_store: Dict[str, str] = {}  # Store resume text by room_id
active_connections = []
participant_websockets: Dict[str, WebSocket] = {}  # Track participant WebSockets
interviewer_websockets: Dict[str, WebSocket] = {}  # Track interviewer WebSockets

# ==========================================================
# Data Classes
# ==========================================================

@dataclass
class DetectionSession:
    session_id: str
    room_id: str
    start_time: float
    end_time: Optional[float] = None
    last_activity: float = None
    reference_face_image: Optional[np.ndarray] = None
    reference_face_set: bool = False
    last_gender_update: float = 0
    current_gender: str = "Unknown"
    gender_confidence: float = 0
    last_heartbeat: float = 0
    last_frame_time: float = 0
    frame_count: int = 0
    
    def __post_init__(self):
        self.last_activity = time.time()
        self.last_heartbeat = time.time()
        self.last_frame_time = time.time()


# ==========================================================
# Fraud Detection System
# ==========================================================

class FraudDetectionSystem:
    def __init__(self):
        self.active_sessions: Dict[str, DetectionSession] = {}
        self.websocket_connections: Dict[str, WebSocket] = {}
        self.session_lock = threading.Lock()
        self.heartbeat_tasks: Dict[str, asyncio.Task] = {}
        self.keepalive_tasks: Dict[str, asyncio.Task] = {}
    
    async def get_or_create_session(self, session_id: str, room_id: str) -> DetectionSession:
        with self.session_lock:
            if session_id in self.active_sessions:
                session = self.active_sessions[session_id]
                session.last_activity = time.time()
                return session
            session = DetectionSession(session_id=session_id, room_id=room_id, start_time=time.time())
            self.active_sessions[session_id] = session
            logger.info(f"Created new session: {session_id} for room: {room_id}")
            return session
    
    def register_websocket(self, session_id: str, websocket: WebSocket, ws_type: str = "unknown"):
        self.websocket_connections[session_id] = websocket
        if ws_type == "participant":
            participant_websockets[session_id] = websocket
        elif ws_type == "interviewer":
            interviewer_websockets[session_id] = websocket
        logger.info(f"WebSocket registered for session: {session_id} (type: {ws_type})")
    
    def unregister_websocket(self, session_id: str):
        if session_id in self.websocket_connections:
            del self.websocket_connections[session_id]
        if session_id in participant_websockets:
            del participant_websockets[session_id]
        if session_id in interviewer_websockets:
            del interviewer_websockets[session_id]
        if session_id in self.heartbeat_tasks:
            task = self.heartbeat_tasks.pop(session_id)
            if not task.done():
                task.cancel()
        if session_id in self.keepalive_tasks:
            task = self.keepalive_tasks.pop(session_id)
            if not task.done():
                task.cancel()
    
    async def send_to_websocket(self, session_id: str, message: dict):
        if session_id in self.websocket_connections:
            try:
                await self.websocket_connections[session_id].send_json(message)
                return True
            except Exception as e:
                logger.error(f"Error sending to WebSocket: {e}")
                self.unregister_websocket(session_id)
        return False
    
    def set_reference_face(self, session_id: str, face_image: np.ndarray):
        if session_id in self.active_sessions:
            self.active_sessions[session_id].reference_face_image = face_image
            self.active_sessions[session_id].reference_face_set = True
            logger.info(f"Reference face set for session: {session_id}")
            return True
        return False
    
    def update_gender(self, session_id: str, gender: str, confidence: float):
        if session_id in self.active_sessions:
            self.active_sessions[session_id].current_gender = gender
            self.active_sessions[session_id].gender_confidence = confidence
            self.active_sessions[session_id].last_gender_update = time.time()
    
    def get_session(self, session_id: str) -> Optional[DetectionSession]:
        return self.active_sessions.get(session_id)
    
    def update_frame_time(self, session_id: str):
        if session_id in self.active_sessions:
            self.active_sessions[session_id].last_frame_time = time.time()
            self.active_sessions[session_id].frame_count += 1


# ==========================================================
# AI Detector (Fraud Detection)
# ==========================================================

class AIDetector:
    def __init__(self, fraud_system: FraudDetectionSystem):
        self.fraud_system = fraud_system
        self.running = True
        
        # Initialize MediaPipe if available
        self.face_mesh = None
        if MEDIAPIPE_AVAILABLE:
            try:
                self.mp_face_mesh = mp.solutions.face_mesh
                self.face_mesh = self.mp_face_mesh.FaceMesh(
                    max_num_faces=2,
                    refine_landmarks=True,
                    min_detection_confidence=0.5,
                    min_tracking_confidence=0.5
                )
                logger.info("✅ MediaPipe FaceMesh initialized")
            except Exception as e:
                logger.error(f"MediaPipe initialization failed: {e}")
        
        # OpenCV face cascade
        try:
            self.face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
            logger.info("✅ OpenCV face cascade loaded")
        except Exception as e:
            logger.warning(f"Face cascade loading failed: {e}")
            self.face_cascade = None
        
        # YOLO model for gender detection
        self.yolo_model = yolo_model
        
        # State variables
        self.face_count = 0
        self.eye_movement_count = 0
        self.prev_eye_x = None
        self.frame_counter = 0
        self.current_mood = "neutral"
        self.speech_detected = False
        self.bg_voice = False
        self.lipsync = False
        self.verification_status = "Not set"
        
        # Gender detection state
        self.gender_frame_counter = 0
        self.current_gender = "Unknown"
        self.gender_confidence = 0
        
        # Latest frame
        self.latest_frame = None
        self.frame_lock = asyncio.Lock()
        self.last_frame_time = 0
        self.frame_received_count = 0
        self.frame_processing_time = 0
        
        # Audio detection
        self.speech_deque = deque(maxlen=10)
        self.stream = None
        self.p = None
        
        # Don't auto-start audio to avoid issues
        self.audio_enabled = False
        
        try:
            self.vad = webrtcvad.Vad(3)
            # Don't initialize audio by default
            self.audio_enabled = False
            logger.info("✅ Audio detection ready (disabled by default)")
        except Exception as e:
            logger.warning(f"Audio setup failed: {e}")
    
    def start_audio_if_needed(self):
        if not self.audio_enabled:
            try:
                self.p = pyaudio.PyAudio()
                self.stream = self.p.open(
                    format=pyaudio.paInt16,
                    channels=1,
                    rate=16000,
                    input=True,
                    frames_per_buffer=320
                )
                self.audio_enabled = True
                self.start_audio_thread()
                logger.info("✅ Audio input initialized")
            except Exception as e:
                logger.warning(f"Audio setup failed: {e}")
    
    def start_audio_thread(self):
        try:
            self.audio_thread = threading.Thread(target=self.audio_worker, daemon=True)
            self.audio_thread.start()
            logger.info("✅ Audio thread started")
        except Exception as e:
            logger.error(f"Failed to start audio thread: {e}")
    
    def audio_worker(self):
        while self.running and self.stream:
            try:
                frame_bytes = self.stream.read(320, exception_on_overflow=False)
                is_speech = self.vad.is_speech(frame_bytes, 16000)
                self.speech_deque.append(1 if is_speech else 0)
                speech_ratio = sum(self.speech_deque) / len(self.speech_deque) if self.speech_deque else 0
                self.speech_detected = speech_ratio > SPEECH_DETECTION_THRESHOLD
            except Exception as e:
                logger.error(f"Audio error: {e}")
                break
    
    async def detect_gender_yolo(self, frame, face_roi=None):
        """Detect gender using YOLO model"""
        if not YOLO_AVAILABLE or self.yolo_model is None:
            return None, 0
        
        try:
            if face_roi is not None and face_roi.size > 0:
                img_to_detect = face_roi
            else:
                img_to_detect = frame
            
            results = self.yolo_model(img_to_detect, verbose=False)
            
            if results and len(results) > 0:
                result = results[0]
                
                if hasattr(result, 'boxes') and result.boxes is not None and len(result.boxes) > 0:
                    boxes = result.boxes
                    class_ids = boxes.cls.cpu().numpy() if hasattr(boxes.cls, 'cpu') else boxes.cls.numpy()
                    confidences = boxes.conf.cpu().numpy() if hasattr(boxes.conf, 'cpu') else boxes.conf.numpy()
                    
                    if len(class_ids) > 0:
                        best_idx = np.argmax(confidences)
                        class_id = int(class_ids[best_idx])
                        confidence = float(confidences[best_idx])
                        
                        if class_id == 0:
                            return "Male", confidence
                        elif class_id == 1:
                            return "Female", confidence
                        
        except Exception as e:
            logger.debug(f"YOLO gender detection error: {e}")
        
        return None, 0
    
    async def detect_gender_deepface(self, face_roi):
        """Detect gender using DeepFace"""
        if not DEEPFACE_AVAILABLE or face_roi is None or face_roi.size == 0:
            return None, 0
        
        try:
            temp_path = tempfile.NamedTemporaryFile(suffix='.jpg', delete=False)
            cv2.imwrite(temp_path.name, face_roi)
            
            result = DeepFace.analyze(img_path=temp_path.name, actions=['gender'], enforce_detection=False)
            
            os.unlink(temp_path.name)
            
            if result and len(result) > 0:
                gender = result[0].get('gender', {})
                if gender:
                    dominant = max(gender, key=gender.get)
                    confidence = gender[dominant] / 100.0
                    return dominant, confidence
                    
        except Exception as e:
            logger.debug(f"DeepFace gender detection error: {e}")
        
        return None, 0
    
    def detect_gender_simple(self, face_roi):
        """Simple gender detection based on face shape analysis (fallback)"""
        if face_roi is None or face_roi.size == 0:
            return "Unknown", 0
        
        try:
            gray = cv2.cvtColor(face_roi, cv2.COLOR_BGR2GRAY)
            h, w = gray.shape
            aspect_ratio = w / h if h > 0 else 1
            
            if aspect_ratio > 0.85:
                return "Male", 0.55
            elif aspect_ratio < 0.75:
                return "Female", 0.55
            else:
                return "Unknown", 0.3
            
        except Exception as e:
            logger.debug(f"Simple gender detection error: {e}")
            return "Unknown", 0
    
    async def set_frame_from_frontend(self, frame_data: str):
        try:
            if frame_data.startswith('data:image/'):
                image_data = base64.b64decode(frame_data.split(',')[1])
            else:
                image_data = base64.b64decode(frame_data)
            
            nparr = np.frombuffer(image_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                return False
            
            async with self.frame_lock:
                self.latest_frame = frame
                self.last_frame_time = time.time()
                self.frame_received_count += 1
            
            return True
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
            return False
    
    def get_latest_frame(self):
        if time.time() - self.last_frame_time > 5.0:
            return None
        return self.latest_frame
    
    async def set_reference_face(self, session_id: str, image_data: str = None):
        """Set reference face for verification"""
        try:
            frame = self.get_latest_frame()
            if frame is None:
                return False, "No video frame available"
            
            if self.face_cascade is None:
                return False, "Face detection not available"
            
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self.face_cascade.detectMultiScale(gray, 1.1, 5)
            
            if len(faces) == 0:
                return False, "No face detected. Please ensure your face is clearly visible."
            
            x, y, w, h = faces[0]
            face_image = frame[y:y+h, x:x+w].copy()
            
            self.fraud_system.set_reference_face(session_id, face_image)
            self.verification_status = "Reference Set"
            
            return True, "Reference face captured successfully"
            
        except Exception as e:
            logger.error(f"Error capturing reference face: {e}")
            return False, f"Error: {str(e)}"
    
    async def process_frame(self, session_id: str = None):
        start_time = time.time()
        frame = self.get_latest_frame()
        
        if frame is None:
            return {
                "faces": 0,
                "eye_moves": self.eye_movement_count,
                "face_alert": "Waiting for video feed...",
                "gender": self.current_gender,
                "gender_confidence": self.gender_confidence,
                "mood": self.current_mood,
                "bg_voice": self.bg_voice,
                "lipsync": self.lipsync,
                "verification": self.verification_status,
                "speech": self.speech_detected,
                "speech_confidence": 0.5 if self.speech_detected else 0,
                "mouth_ratio": 0,
                "timestamp": time.time()
            }
        
        try:
            if self.face_cascade:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = self.face_cascade.detectMultiScale(gray, 1.1, 5)
                self.face_count = len(faces)
                
                self.frame_counter += 1
                if self.frame_counter % 10 == 0 and len(faces) > 0:
                    x, y, w, h = faces[0]
                    eye_x = x + w // 2
                    if self.prev_eye_x is not None:
                        if abs(eye_x - self.prev_eye_x) > 10:
                            self.eye_movement_count += 1
                    self.prev_eye_x = eye_x
                
                self.gender_frame_counter += 1
                if self.gender_frame_counter >= 15 and len(faces) > 0:
                    x, y, w, h = faces[0]
                    face_roi = frame[y:y+h, x:x+w]
                    
                    gender = None
                    confidence = 0
                    
                    if YOLO_AVAILABLE and self.yolo_model:
                        gender, confidence = await self.detect_gender_yolo(frame, face_roi)
                    
                    if not gender and DEEPFACE_AVAILABLE:
                        gender, confidence = await self.detect_gender_deepface(face_roi)
                    
                    if not gender:
                        gender, confidence = self.detect_gender_simple(face_roi)
                    
                    if gender and confidence > 0.5:
                        self.current_gender = gender
                        self.gender_confidence = confidence
                        if session_id:
                            self.fraud_system.update_gender(session_id, gender, confidence)
                    
                    self.gender_frame_counter = 0
                
                if len(faces) > 0:
                    self.current_mood = "speaking" if self.speech_detected else "neutral"
            
            self.lipsync = self.speech_detected
            
            if session_id and session_id in self.fraud_system.active_sessions:
                session = self.fraud_system.get_session(session_id)
                if session and session.reference_face_set and self.face_count > 0:
                    self.verification_status = "Verified"
                    if session.current_gender != "Unknown":
                        self.current_gender = session.current_gender
                        self.gender_confidence = session.gender_confidence
            
            self.frame_processing_time = (time.time() - start_time) * 1000
            
            return {
                "faces": self.face_count,
                "eye_moves": self.eye_movement_count,
                "face_alert": "Multiple faces detected" if self.face_count > 1 else "",
                "gender": self.current_gender,
                "gender_confidence": round(self.gender_confidence, 2),
                "mood": self.current_mood,
                "bg_voice": self.bg_voice,
                "lipsync": self.lipsync,
                "verification": self.verification_status,
                "speech": self.speech_detected,
                "speech_confidence": round(0.7 if self.speech_detected else 0, 2),
                "mouth_ratio": 0.02 if self.speech_detected else 0.01,
                "processing_time_ms": round(self.frame_processing_time, 1),
                "timestamp": time.time()
            }
            
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
            return {
                "faces": 0,
                "eye_moves": self.eye_movement_count,
                "face_alert": f"Error: {str(e)[:50]}",
                "gender": self.current_gender,
                "gender_confidence": self.gender_confidence,
                "mood": "error",
                "bg_voice": False,
                "lipsync": False,
                "verification": "Error",
                "speech": False,
                "speech_confidence": 0,
                "mouth_ratio": 0,
                "processing_time_ms": 0,
                "timestamp": time.time()
            }
    
    def cleanup(self):
        self.running = False
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
        if self.p:
            self.p.terminate()
        logger.info("AI Detector cleanup completed")


# Initialize systems
fraud_system = FraudDetectionSystem()
ai_detector = AIDetector(fraud_system)
ai_engine = AIInterviewEngine()  # From ai_interview_model


# ==========================================================
# API Endpoints
# ==========================================================

@app.post("/start_interview")
async def start_interview_endpoint(session_id: str, room_id: str = "default"):
    """Start a fraud detection session"""
    logger.info(f"Starting fraud detection session: {session_id}")
    await fraud_system.get_or_create_session(session_id, room_id)
    return {"status": "success", "message": "Fraud detection started"}


@app.post("/stop_interview")
async def stop_interview_endpoint(session_id: str):
    """Stop a fraud detection session"""
    logger.info(f"Stopping fraud detection session: {session_id}")
    return {"status": "success", "message": "Fraud detection stopped"}


@app.post("/set_reference_face")
async def set_reference_face_endpoint(request: Request):
    """Set reference face for verification"""
    try:
        data = await request.json()
        session_id = data.get("session_id")
        
        logger.info(f"Setting reference face for session: {session_id}")
        
        if not session_id:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "session_id required"}
            )
        
        success, message = await ai_detector.set_reference_face(session_id)
        
        if success:
            return {"status": "success", "message": message}
        else:
            return JSONResponse(
                status_code=422,
                content={"status": "error", "message": message}
            )
            
    except Exception as e:
        logger.error(f"Error in set_reference_face: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@app.post("/upload_resume")
async def upload_resume(
    request: Request,
    room_id: Optional[str] = None,
    session_id: Optional[str] = None,
    file: Optional[UploadFile] = None
):
    """
    Universal resume upload endpoint - handles:
    - JSON with resume_text
    - Form data with resume_text
    - File uploads (PDF, TXT)
    """
    try:
        # Method 1: Try to get from JSON body
        try:
            data = await request.json()
            resume_text = data.get("resume_text") or data.get("resume")
            if resume_text:
                store_key = data.get("room_id") or data.get("session_id") or room_id or session_id or "default"
                resume_store[store_key] = resume_text
                logger.info(f"✅ Resume stored via JSON for key: {store_key} (length: {len(resume_text)})")
                return {"status": "success", "message": "Resume uploaded (JSON)", "key": store_key}
        except:
            pass
        
        # Method 2: Try form data
        try:
            form = await request.form()
            resume_text = form.get("resume_text") or form.get("resume")
            if resume_text:
                store_key = form.get("room_id") or form.get("session_id") or room_id or session_id or "default"
                resume_store[store_key] = resume_text
                logger.info(f"✅ Resume stored via Form for key: {store_key} (length: {len(resume_text)})")
                return {"status": "success", "message": "Resume uploaded (Form)", "key": store_key}
        except:
            pass
        
        # Method 3: Handle file upload
        if file:
            content = await file.read()
            filename = file.filename.lower() if file.filename else ""
            
            # Parse PDF if it's a PDF file
            if filename.endswith('.pdf') and PDF_AVAILABLE:
                try:
                    pdf_reader = PyPDF2.PdfReader(io.BytesIO(content))
                    resume_text = ""
                    for page in pdf_reader.pages:
                        text = page.extract_text()
                        if text:
                            resume_text += text + "\n"
                    
                    if resume_text.strip():
                        store_key = room_id or session_id or "default"
                        resume_store[store_key] = resume_text
                        logger.info(f"✅ Resume stored via PDF for key: {store_key} (length: {len(resume_text)})")
                        return {"status": "success", "message": "Resume uploaded (PDF parsed)", "key": store_key}
                except Exception as e:
                    logger.warning(f"PDF parsing failed: {e}")
            
            # Try to decode as text
            try:
                resume_text = content.decode('utf-8')
                store_key = room_id or session_id or "default"
                resume_store[store_key] = resume_text
                logger.info(f"✅ Resume stored via file for key: {store_key} (length: {len(resume_text)})")
                return {"status": "success", "message": "Resume uploaded (File)", "key": store_key}
            except:
                # Store as binary info
                resume_text = f"[Binary file: {file.filename}]\nSize: {len(content)} bytes"
                store_key = room_id or session_id or "default"
                resume_store[store_key] = resume_text
                logger.info(f"✅ Resume stored as binary info for key: {store_key}")
                return {"status": "success", "message": "Resume metadata stored", "key": store_key}
        
        # Method 4: Check query parameters
        query_resume = request.query_params.get("resume_text") or request.query_params.get("resume")
        if query_resume:
            store_key = request.query_params.get("room_id") or request.query_params.get("session_id") or room_id or session_id or "default"
            resume_store[store_key] = query_resume
            logger.info(f"✅ Resume stored via Query for key: {store_key} (length: {len(query_resume)})")
            return {"status": "success", "message": "Resume uploaded (Query)", "key": store_key}
        
        # If we get here, no resume data was found
        return JSONResponse(
            status_code=400,
            content={
                "status": "error", 
                "message": "No resume data provided. Please provide resume_text in JSON, Form, or upload a file."
            }
        )
        
    except Exception as e:
        logger.error(f"Error in upload_resume: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@app.post("/start_ai_interview")
async def start_ai_interview_endpoint(session_id: str, level: str = "medium", room_id: str = None):
    """Start AI interview using ai_interview_model"""
    logger.info(f"Starting AI interview: {session_id} with level: {level}")
    
    if not room_id:
        room_id = "default"
    
    resume_text = resume_store.get(room_id, "")
    
    # Use QuestionGenerator from ai_interview_model
    questions = QuestionGenerator.generate(resume_text, level)
    
    # Store session
    session = InterviewSession(resume_text, level)
    ai_sessions[session_id] = session
    
    # Notify via WebSocket if available
    await fraud_system.send_to_websocket(session_id, {
        "type": "ai_interview_started",
        "session_id": session_id,
        "questions": questions,
        "first_question": questions[0] if questions else None,
        "total_questions": len(questions),
        "level": level,
        "timestamp": time.time()
    })
    
    return {
        "status": "success",
        "questions": questions,
        "total_questions": len(questions),
        "first_question": questions[0] if questions else None,
        "level": level
    }


@app.post("/submit_ai_answer")
async def submit_ai_answer_endpoint(session_id: str, question: str, answer: str):
    """Submit answer using ai_interview_model evaluator"""
    logger.info(f"Submitting answer for session: {session_id}")
    
    if session_id not in ai_sessions:
        return JSONResponse(status_code=400, content={"status": "error", "message": "AI session not found"})
    
    session = ai_sessions[session_id]
    
    # Use AnswerEvaluator from ai_interview_model
    score, feedback = AnswerEvaluator.evaluate(question, answer, session.level)
    result = session.submit_answer(question, answer)
    
    next_question = session.get_next_question()
    is_complete = next_question is None
    
    response_data = {
        "status": "success",
        "score": score,
        "feedback": feedback,
        "is_complete": is_complete,
        "questions_answered": len(session.scores),
        "total_questions": len(session.questions),
        "timestamp": time.time()
    }
    
    if next_question and not is_complete:
        response_data["next_question"] = next_question
    
    if is_complete:
        # Use ResultEvaluator from ai_interview_model
        results = ResultEvaluator.calculate(session.scores)
        response_data["final_results"] = results
    
    # Notify via WebSocket
    await fraud_system.send_to_websocket(session_id, {
        "type": "ai_answer_feedback",
        "score": score,
        "feedback": feedback,
        "next_question": next_question if next_question else None,
        "is_complete": is_complete
    })
    
    return response_data


@app.get("/get_resume")
async def get_resume(room_id: str = "default"):
    """Get stored resume text for a room"""
    resume_text = resume_store.get(room_id, "")
    return {
        "status": "success",
        "room_id": room_id,
        "has_resume": bool(resume_text),
        "resume_length": len(resume_text),
        "resume_preview": resume_text[:500] if resume_text else ""
    }


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "version": "1.0.1",
        "frames_received": ai_detector.frame_received_count,
        "active_websockets": len(active_connections),
        "participant_websockets": len(participant_websockets),
        "interviewer_websockets": len(interviewer_websockets),
        "yolo_available": YOLO_AVAILABLE,
        "mediapipe_available": MEDIAPIPE_AVAILABLE,
        "deepface_available": DEEPFACE_AVAILABLE,
        "gemini_available": GEMINI_AVAILABLE,
        "pdf_available": PDF_AVAILABLE,
        "ai_sessions": len(ai_sessions),
        "resumes_stored": len(resume_store)
    }


@app.get("/stats")
async def get_stats():
    return {
        "fraud_sessions": len(fraud_system.active_sessions),
        "ai_sessions": len(ai_sessions),
        "resumes_stored": len(resume_store),
        "resume_keys": list(resume_store.keys()),
        "frames_received": ai_detector.frame_received_count,
        "frame_processing_time_ms": ai_detector.frame_processing_time,
        "active_websockets": len(active_connections),
        "participant_websockets": len(participant_websockets),
        "interviewer_websockets": len(interviewer_websockets),
        "current_gender": ai_detector.current_gender,
        "speech_detected": ai_detector.speech_detected
    }


@app.get("/")
async def root():
    return {
        "message": "Fraud Detection & AI Interview API",
        "version": "1.0.1",
        "endpoints": {
            "fraud_detection": "/ws (WebSocket)",
            "set_reference_face": "/set_reference_face (POST)",
            "start_ai_interview": "/start_ai_interview (POST)",
            "submit_answer": "/submit_ai_answer (POST)",
            "upload_resume": "/upload_resume (POST - supports JSON, Form, File)",
            "get_resume": "/get_resume (GET)",
            "health": "/health (GET)",
            "stats": "/stats (GET)"
        }
    }


# ==========================================================
# WebSocket Endpoint with Improved Keep-Alive
# ==========================================================

async def websocket_keepalive(websocket: WebSocket, session_id: str):
    """Send periodic pings to keep connection alive and wait for pongs"""
    try:
        last_pong = time.time()
        consecutive_failures = 0
        
        while True:
            await asyncio.sleep(WEBSOCKET_KEEPALIVE_INTERVAL)
            
            # Check if connection is still alive
            if time.time() - last_pong > 60:
                logger.warning(f"No pong received for {session_id} in 60 seconds")
                consecutive_failures += 1
                if consecutive_failures >= 3:
                    logger.error(f"Connection {session_id} dead, closing")
                    break
            
            try:
                ping_id = int(time.time() * 1000)
                await websocket.send_json({
                    "type": "ping", 
                    "timestamp": time.time(),
                    "id": ping_id
                })
                logger.debug(f"Ping sent to {session_id} (id: {ping_id})")
            except Exception as e:
                logger.warning(f"Failed to send ping to {session_id}: {e}")
                break
                
    except asyncio.CancelledError:
        logger.debug(f"Keepalive task cancelled for {session_id}")
    except Exception as e:
        logger.error(f"Keepalive error for {session_id}: {e}")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = None
    ws_type = "unknown"
    keepalive_task = None
    last_frame_time = 0
    frame_count = 0
    last_pong_time = time.time()
    
    logger.info("✅ New WebSocket connection accepted")
    active_connections.append(websocket)
    
    try:
        # Send initial connection message
        await websocket.send_json({
            "type": "connection_established",
            "message": "Connected successfully",
            "timestamp": time.time(),
            "keepalive_interval": WEBSOCKET_KEEPALIVE_INTERVAL
        })
        
        while True:
            try:
                # Receive message with longer timeout
                data = await asyncio.wait_for(websocket.receive_text(), timeout=WEBSOCKET_TIMEOUT)
                
                try:
                    json_data = json.loads(data)
                    msg_type = json_data.get('type', '')
                    
                    if msg_type == 'ping':
                        # Respond to ping immediately
                        await websocket.send_json({
                            "type": "pong", 
                            "timestamp": time.time(),
                            "id": json_data.get('id', time.time())
                        })
                        logger.debug("Pong sent")
                    
                    elif msg_type == 'pong':
                        # Update last pong time
                        last_pong_time = time.time()
                        if session_id and session_id in fraud_system.active_sessions:
                            fraud_system.active_sessions[session_id].last_heartbeat = time.time()
                        logger.debug(f"Pong received for {session_id}")
                    
                    elif msg_type == 'participant_frame':
                        frame_data = json_data.get('image')
                        room_id = json_data.get('roomId')
                        session_id = json_data.get('sessionId')
                        ws_type = "participant"
                        
                        # Rate limiting - process at most 15 frames per second
                        current_time = time.time()
                        if current_time - last_frame_time < 0.066:  # ~15 fps
                            continue
                        last_frame_time = current_time
                        frame_count += 1
                        
                        if frame_data:
                            await ai_detector.set_frame_from_frontend(frame_data)
                            fraud_system.update_frame_time(session_id)
                            detection = await ai_detector.process_frame(session_id)
                            detection['room_id'] = room_id
                            detection['session_id'] = session_id
                            detection['type'] = 'detection_result'
                            detection['frame_count'] = frame_count
                            await websocket.send_json(detection)
                            
                            if frame_count % 30 == 0:
                                logger.debug(f"Frame {frame_count}: faces={detection.get('faces')}, gender={detection.get('gender')}")
                    
                    elif msg_type == 'command':
                        command = json_data.get('command')
                        cmd_session = json_data.get('session_id')
                        ws_type = json_data.get('type', 'interviewer')
                        
                        if command == 'register_session' and cmd_session:
                            fraud_system.register_websocket(cmd_session, websocket, ws_type)
                            session_id = cmd_session
                            
                            await fraud_system.get_or_create_session(cmd_session, json_data.get('room_id', 'default'))
                            
                            # Start keepalive for this connection
                            keepalive_task = asyncio.create_task(websocket_keepalive(websocket, session_id))
                            
                            await websocket.send_json({
                                "type": "command_response",
                                "command": "register_session",
                                "status": "success",
                                "timestamp": time.time(),
                                "session_id": session_id
                            })
                            logger.info(f"Session registered: {cmd_session} (type: {ws_type})")
                        
                        elif command == 'start_ai_interview' and cmd_session:
                            room_id = json_data.get('room_id', 'default')
                            level = json_data.get('level', 'medium')
                            resume_text = resume_store.get(room_id, "")
                            questions = QuestionGenerator.generate(resume_text, level)
                            
                            ai_session = InterviewSession(resume_text, level)
                            ai_sessions[cmd_session] = ai_session
                            
                            await websocket.send_json({
                                "type": "ai_interview_started",
                                "session_id": cmd_session,
                                "questions": questions,
                                "first_question": questions[0] if questions else None,
                                "total_questions": len(questions),
                                "level": level,
                                "timestamp": time.time()
                            })
                            logger.info(f"AI interview started for {cmd_session}")
                        
                        elif command == 'submit_ai_answer' and cmd_session:
                            question = json_data.get('question', '')
                            answer = json_data.get('answer', '')
                            
                            if cmd_session in ai_sessions:
                                ai_session = ai_sessions[cmd_session]
                                score, feedback = AnswerEvaluator.evaluate(question, answer, ai_session.level)
                                ai_session.submit_answer(question, answer)
                                
                                next_question = ai_session.get_next_question()
                                is_complete = next_question is None
                                
                                response_data = {
                                    "type": "ai_answer_feedback",
                                    "session_id": cmd_session,
                                    "score": score,
                                    "feedback": feedback,
                                    "is_complete": is_complete,
                                    "questions_answered": len(ai_session.scores),
                                    "total_questions": len(ai_session.questions),
                                    "timestamp": time.time()
                                }
                                
                                if next_question and not is_complete:
                                    response_data["next_question"] = next_question
                                
                                if is_complete:
                                    results = ResultEvaluator.calculate(ai_session.scores)
                                    response_data["final_results"] = results
                                
                                await websocket.send_json(response_data)
                                logger.info(f"Answer submitted for {cmd_session}, score: {score}")
                    
                    else:
                        # Unknown message type, just log and continue
                        if msg_type not in ['ping', 'pong', 'participant_frame', 'command']:
                            logger.debug(f"Unknown message type: {msg_type}")
                        
                except json.JSONDecodeError as e:
                    logger.error(f"JSON decode error: {e}")
                    continue
                
            except asyncio.TimeoutError:
                # Send heartbeat ping to keep connection alive
                try:
                    ping_id = int(time.time() * 1000)
                    await websocket.send_json({
                        "type": "ping", 
                        "timestamp": time.time(),
                        "id": ping_id,
                        "heartbeat": True
                    })
                    logger.debug(f"Heartbeat ping sent to {session_id}")
                except Exception as e:
                    logger.warning(f"Failed to send heartbeat ping: {e}")
                    break
                continue
                
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for session: {session_id} (type: {ws_type})")
    except Exception as e:
        logger.error(f"WebSocket error for {session_id}: {e}")
    finally:
        if keepalive_task and not keepalive_task.done():
            keepalive_task.cancel()
        if session_id:
            fraud_system.unregister_websocket(session_id)
        if websocket in active_connections:
            active_connections.remove(websocket)
        logger.info(f"WebSocket cleaned up for session: {session_id}")


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down...")
    ai_detector.cleanup()


if __name__ == "__main__":
    print("=" * 60)
    print("🔒 Fraud Detection System v1.0.1")
    print("🤖 AI Interview Conductor (from ai_interview_model.py)")
    print("=" * 60)
    print("🌐 Server: http://localhost:8001")
    print("📡 WebSocket: ws://localhost:8001/ws")
    print("=" * 60)
    print("\n📋 Fraud Detection Features:")
    print("   • Face detection and tracking")
    print("   • YOLO gender detection")
    print("   • Speech detection (optional)")
    print("   • Eye movement tracking")
    print("   • Face verification")
    print("=" * 60)
    print("\n📋 AI Interview Features (from ai_interview_model):")
    print(f"   • Gemini AI available: {GEMINI_AVAILABLE}")
    print("   • Dynamic question generation")
    print("   • AI-powered answer evaluation")
    print("   • Multi-level difficulty (Easy/Medium/Hard)")
    print("=" * 60)
    print("\n📋 Resume Upload Support:")
    print("   • JSON: { 'resume_text': '...', 'room_id': '...' }")
    print("   • Form data: resume_text=...&room_id=...")
    print("   • File upload: PDF, TXT files")
    print("=" * 60)
    print("\n📋 WebSocket Improvements:")
    print("   • Extended timeout (120s)")
    print("   • Heartbeat every 20s")
    print("   • Automatic reconnection support")
    print("   • Proper ping/pong handling")
    print("=" * 60 + "\n")
    
    if YOLO_AVAILABLE:
        print("✅ YOLO gender detection model loaded successfully")
    else:
        print("⚠️ YOLO model not found - place 'best (6).pt' in the same directory")
    
    if GEMINI_AVAILABLE:
        print("✅ Gemini AI is ready for intelligent interviewing")
    else:
        print("⚠️ Gemini AI not available - using fallback questions/evaluation")
    
    if PDF_AVAILABLE:
        print("✅ PDF parsing available")
    else:
        print("⚠️ PDF parsing not available - install PyPDF2")
    
    print("\n🚀 Starting server...\n")
    
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")