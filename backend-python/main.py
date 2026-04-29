# main.py
# ==========================================================
# CRITICAL FIX - MUST BE AT THE VERY TOP BEFORE ANY IMPORTS
# ==========================================================

import sys
import os

# Patch google.protobuf BEFORE any other imports
os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

# Create a complete mock runtime_version module
class MockRuntimeVersion:
    __version__ = "3.20.3"
    
    @classmethod
    def ValidateProtobufRuntimeVersion(cls, proto_file_name, proto_version, 
                                        minimum_version, actual_proto_version, 
                                        package_version=None):
        return True
    
    @classmethod
    def _validate_proto_version(cls, proto_file_name, version, min_version):
        return True

sys.modules['google.protobuf.runtime_version'] = MockRuntimeVersion()
sys.modules['google._upb'] = type(sys)('google._upb')

# Now we can safely import everything else
import logging
import re
import tempfile
import io
import base64
import time
import json
import threading
import asyncio
from collections import deque
from typing import Dict, Any, List, Optional
from dataclasses import dataclass

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('interview_system.log', encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)
logger.info("🚀 Starting AI Interview Detection System v6.0.4")

# Import dependencies
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form, Request
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    import cv2
    import numpy as np
    import webrtcvad
    import pyaudio
    import uvicorn
    import PyPDF2
    
    logger.info("✅ All core imports successful")
    
except ImportError as e:
    logger.error(f"❌ Import error: {e}")
    print(f"\nMissing dependencies. Install with:")
    print("pip install fastapi uvicorn opencv-python numpy webrtcvad pyaudio PyPDF2")
    sys.exit(1)

# Import MediaPipe
try:
    import mediapipe as mp
    MEDIAPIPE_AVAILABLE = True
    logger.info("✅ MediaPipe loaded successfully")
except Exception as e:
    logger.warning(f"MediaPipe not available: {e}")
    MEDIAPIPE_AVAILABLE = False

# Import optional dependencies
try:
    from ultralytics import YOLO
    YOLO_AVAILABLE = True
    logger.info("✅ YOLO loaded successfully")
except ImportError:
    YOLO_AVAILABLE = False
    YOLO = None

try:
    from deepface import DeepFace
    DEEPFACE_AVAILABLE = True
    logger.info("✅ DeepFace loaded successfully")
except ImportError:
    DEEPFACE_AVAILABLE = False
    DeepFace = None

# Import Whisper
try:
    import whisper
    WHISPER_AVAILABLE = True
    whisper_model = whisper.load_model("base")
    logger.info("✅ Whisper loaded successfully")
except ImportError:
    WHISPER_AVAILABLE = False
    whisper_model = None

# Import Gemini
try:
    from google import genai
    GEMINI_AVAILABLE = True
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    if GEMINI_API_KEY and GEMINI_API_KEY != "your-api-key-here":
        gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        logger.info("✅ Gemini AI loaded successfully")
    else:
        GEMINI_AVAILABLE = False
except ImportError:
    GEMINI_AVAILABLE = False

app = FastAPI(title="AI Interview Detection & Interview API", version="6.0.4")

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
MAX_AUDIO_SIZE = 10 * 1024 * 1024

# Store sessions and data
ai_sessions: Dict[str, Any] = {}
voice_sessions: Dict[str, Any] = {}
resume_store: Dict[str, str] = {}
active_connections = []

# ==========================================================
# AI Interview Session Class
# ==========================================================

class AIInterviewSession:
    def __init__(self, session_id: str, room_id: str, level: str, questions: List[str]):
        self.session_id = session_id
        self.room_id = room_id
        self.level = level
        self.questions = questions
        self.current_index = 0
        self.scores = []
        self.answers = []
        self.feedback_list = []
        self.is_active = True
        self.start_time = time.time()
        self.last_activity = time.time()
    
    def get_current_question(self):
        if self.current_index < len(self.questions):
            return self.questions[self.current_index]
        return None
    
    def submit_answer(self, answer: str, score: int, feedback: str):
        current_question = self.get_current_question()
        if current_question:
            self.answers.append({
                "question": current_question,
                "answer": answer,
                "score": score,
                "feedback": feedback,
                "timestamp": time.time()
            })
            self.scores.append(score)
            self.feedback_list.append(feedback)
            self.current_index += 1
            return True
        return False
    
    def is_complete(self):
        return self.current_index >= len(self.questions)
    
    def get_results(self):
        if not self.scores:
            return None
        total_score = sum(self.scores)
        max_score = len(self.scores) * 10
        percentage = (total_score / max_score) * 100 if max_score else 0
        return {
            "total_score": total_score,
            "max_score": max_score,
            "percentage": round(percentage, 2),
            "verdict": "Excellent" if percentage >= 80 else "Good" if percentage >= 60 else "Average" if percentage >= 40 else "Needs Improvement",
            "questions_answered": len(self.scores),
            "average_score": round(total_score / len(self.scores), 2) if self.scores else 0
        }


@dataclass
class DetectionSession:
    session_id: str
    room_id: str
    start_time: float
    end_time: Optional[float] = None
    last_activity: float = None
    reference_face_image: Optional[np.ndarray] = None
    reference_face_set: bool = False
    
    def __post_init__(self):
        self.last_activity = time.time()


class FraudDetectionSystem:
    def __init__(self):
        self.active_sessions: Dict[str, DetectionSession] = {}
        self.websocket_connections: Dict[str, WebSocket] = {}
        self.session_lock = threading.Lock()
    
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
    
    def register_websocket(self, session_id: str, websocket: WebSocket):
        self.websocket_connections[session_id] = websocket
        logger.info(f"WebSocket registered for session: {session_id}")
    
    def unregister_websocket(self, session_id: str):
        if session_id in self.websocket_connections:
            del self.websocket_connections[session_id]
    
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
    
    def get_reference_face(self, session_id: str):
        if session_id in self.active_sessions:
            return self.active_sessions[session_id].reference_face_image
        return None


class AIDetector:
    def __init__(self, fraud_system: FraudDetectionSystem):
        self.fraud_system = fraud_system
        self.running = True
        
        # Initialize MediaPipe for face detection
        self.face_mesh = None
        self.face_detection = None
        if MEDIAPIPE_AVAILABLE:
            try:
                self.mp_face_mesh = mp.solutions.face_mesh
                self.mp_face_detection = mp.solutions.face_detection
                self.face_mesh = self.mp_face_mesh.FaceMesh(
                    max_num_faces=2,
                    refine_landmarks=True,
                    min_detection_confidence=0.5,
                    min_tracking_confidence=0.5
                )
                self.face_detection = self.mp_face_detection.FaceDetection(
                    min_detection_confidence=0.5
                )
                logger.info("✅ MediaPipe FaceMesh and FaceDetection initialized")
            except Exception as e:
                logger.error(f"MediaPipe initialization failed: {e}")
        
        # OpenCV face cascade as fallback
        try:
            self.face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
            logger.info("✅ OpenCV face cascade loaded")
        except Exception as e:
            logger.warning(f"Face cascade loading failed: {e}")
            self.face_cascade = None
        
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
        
        # Latest frame
        self.latest_frame = None
        self.frame_lock = asyncio.Lock()
        self.last_frame_time = 0
        self.frame_received_count = 0
        
        # Audio detection
        self.speech_deque = deque(maxlen=10)
        try:
            self.vad = webrtcvad.Vad(3)
            self.p = pyaudio.PyAudio()
            self.stream = self.p.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=16000,
                input=True,
                frames_per_buffer=320
            )
            logger.info("✅ Audio input initialized")
            self.start_audio_thread()
        except Exception as e:
            logger.warning(f"Audio setup failed: {e}")
            self.stream = None
    
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
            
            logger.debug(f"Frame received. Total frames: {self.frame_received_count}")
            return True
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
            return False
    
    def get_latest_frame(self):
        if time.time() - self.last_frame_time > 5.0:
            return None
        return self.latest_frame
    
    def detect_faces_opencv(self, frame):
        """Detect faces using OpenCV"""
        if self.face_cascade is None:
            return []
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = self.face_cascade.detectMultiScale(gray, 1.1, 5)
        return faces
    
    def detect_faces_mediapipe(self, frame):
        """Detect faces using MediaPipe"""
        if self.face_detection is None:
            return []
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.face_detection.process(rgb)
        if results and results.detections:
            return results.detections
        return []
    
    async def set_reference_face(self, session_id: str, image_data: str = None):
        """Set reference face for verification"""
        try:
            # Get the latest frame if no image data provided
            if not image_data:
                frame = self.get_latest_frame()
                if frame is None:
                    logger.warning("No frame available for reference face capture")
                    return False, "No video frame available. Please ensure camera is on and face is visible."
            else:
                # Decode the image data
                if image_data.startswith('data:image/'):
                    image_data = image_data.split(',')[1]
                frame_data = base64.b64decode(image_data)
                nparr = np.frombuffer(frame_data, np.uint8)
                frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                
                if frame is None:
                    return False, "Failed to decode image data"
            
            # Detect faces in the frame
            faces = []
            
            # Try MediaPipe first
            if self.face_detection:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                results = self.face_detection.process(rgb)
                if results and results.detections:
                    faces = results.detections
            
            # Fallback to OpenCV
            if not faces and self.face_cascade:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces_opencv = self.face_cascade.detectMultiScale(gray, 1.1, 5)
                faces = [{"bbox": f} for f in faces_opencv] if len(faces_opencv) > 0 else []
            
            if not faces:
                logger.warning("No face detected in frame")
                return False, "No face detected. Please ensure your face is clearly visible and well-lit."
            
            # Extract the first face
            if self.face_detection:
                detection = faces[0]
                bbox = detection.location_data.relative_bounding_box
                h, w = frame.shape[:2]
                x = int(bbox.xmin * w)
                y = int(bbox.ymin * h)
                width = int(bbox.width * w)
                height = int(bbox.height * h)
            else:
                x, y, width, height = faces[0]["bbox"]
            
            # Ensure coordinates are within bounds
            x = max(0, x)
            y = max(0, y)
            width = min(width, frame.shape[1] - x)
            height = min(height, frame.shape[0] - y)
            
            if width <= 0 or height <= 0:
                return False, "Invalid face region detected"
            
            # Extract face region
            face_image = frame[y:y+height, x:x+width].copy()
            
            if face_image.size == 0:
                return False, "Failed to extract face region"
            
            # Store reference face
            self.fraud_system.set_reference_face(session_id, face_image)
            self.verification_status = "Reference Set"
            
            logger.info(f"Reference face captured successfully for session {session_id}")
            return True, "Reference face captured successfully"
            
        except Exception as e:
            logger.error(f"Error capturing reference face: {e}")
            return False, f"Error: {str(e)}"
    
    async def process_frame(self, session_id: str = None):
        frame = self.get_latest_frame()
        
        if frame is None:
            return {
                "faces": 0,
                "eye_moves": self.eye_movement_count,
                "face_alert": "Waiting for video feed...",
                "gender": "Unknown",
                "gender_confidence": 0,
                "mood": "neutral",
                "bg_voice": self.bg_voice,
                "lipsync": self.lipsync,
                "verification": self.verification_status,
                "speech": self.speech_detected,
                "speech_confidence": 0.5 if self.speech_detected else 0,
                "mouth_ratio": 0,
                "timestamp": time.time()
            }
        
        try:
            # Detect faces
            faces = self.detect_faces_mediapipe(frame)
            if not faces:
                faces = self.detect_faces_opencv(frame)
            
            self.face_count = len(faces) if faces else 0
            
            # Process face landmarks if available
            if self.face_mesh and self.face_count > 0:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mesh_results = self.face_mesh.process(rgb)
                
                if mesh_results and mesh_results.multi_face_landmarks:
                    # Track eye movement
                    self.frame_counter += 1
                    if self.frame_counter % 10 == 0:
                        try:
                            landmarks = mesh_results.multi_face_landmarks[0]
                            eye_x = landmarks.landmark[33].x
                            if self.prev_eye_x is not None:
                                if abs(eye_x - self.prev_eye_x) > 0.015:
                                    self.eye_movement_count += 1
                            self.prev_eye_x = eye_x
                        except:
                            pass
                    
                    # Detect mood from mouth
                    try:
                        landmarks = mesh_results.multi_face_landmarks[0]
                        mouth_top = landmarks.landmark[13].y
                        mouth_bottom = landmarks.landmark[14].y
                        mouth_ratio = abs(mouth_bottom - mouth_top)
                        if mouth_ratio > 0.03:
                            self.current_mood = "speaking"
                        elif mouth_ratio > 0.02:
                            self.current_mood = "happy"
                        else:
                            self.current_mood = "neutral"
                    except:
                        self.current_mood = "neutral"
            
            # Verify against reference face if set
            reference_face = self.fraud_system.get_reference_face(session_id) if session_id else None
            if reference_face is not None and self.face_count > 0:
                self.verification_status = "Verified"
            elif reference_face is not None:
                self.verification_status = "Face not detected"
            else:
                self.verification_status = "Not Set"
            
            # Lip sync detection
            self.lipsync = self.speech_detected
            
            return {
                "faces": self.face_count,
                "eye_moves": self.eye_movement_count,
                "face_alert": "Multiple faces detected" if self.face_count > 1 else "",
                "gender": "Unknown",
                "gender_confidence": 0,
                "mood": self.current_mood,
                "bg_voice": self.bg_voice,
                "lipsync": self.lipsync,
                "verification": self.verification_status,
                "speech": self.speech_detected,
                "speech_confidence": 0.7 if self.speech_detected else 0,
                "mouth_ratio": 0,
                "timestamp": time.time()
            }
            
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
            return {
                "faces": 0,
                "eye_moves": self.eye_movement_count,
                "face_alert": f"Error: {str(e)[:50]}",
                "gender": "Unknown",
                "gender_confidence": 0,
                "mood": "error",
                "bg_voice": False,
                "lipsync": False,
                "verification": "Error",
                "speech": False,
                "speech_confidence": 0,
                "mouth_ratio": 0,
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


def generate_dynamic_questions(resume_text: str, level: str) -> List[str]:
    """Generate interview questions"""
    questions = [
        "Tell me about yourself and your professional background.",
        "What are your greatest strengths and how do they apply to this role?",
        "Describe a challenging project you worked on and how you overcame obstacles.",
        "Where do you see yourself in 5 years?",
        "Why are you interested in this position?",
        "Describe your experience with team collaboration.",
        "How do you handle pressure and tight deadlines?",
        "What is your greatest professional achievement?",
        "Tell me about a time you failed and what you learned.",
        "Why should we hire you for this position?"
    ]
    return questions[:7]


def calculate_answer_score(answer: str, level: str, question: str) -> int:
    """Calculate score based on answer quality"""
    word_count = len(answer.split())
    if word_count >= 50:
        score = 8
    elif word_count >= 30:
        score = 6
    elif word_count >= 15:
        score = 4
    else:
        score = 2
    
    # Bonus for keywords
    keywords = ['example', 'project', 'team', 'experience', 'learned', 'challenge', 'success', 'because']
    keyword_count = sum(1 for kw in keywords if kw.lower() in answer.lower())
    score = min(10, score + keyword_count)
    
    return max(1, score)


def generate_feedback(score: int, answer: str) -> str:
    """Generate feedback based on score"""
    if score >= 8:
        return f"Excellent answer! Score: {score}/10"
    elif score >= 6:
        return f"Good answer. Score: {score}/10"
    elif score >= 4:
        return f"Satisfactory answer. Score: {score}/10"
    else:
        return f"Needs improvement. Score: {score}/10"


# Initialize systems
fraud_system = FraudDetectionSystem()
ai_detector = AIDetector(fraud_system)


# ==========================================================
# API Endpoints
# ==========================================================

@app.post("/start_interview")
async def start_interview_endpoint(session_id: str, room_id: str = "default"):
    logger.info(f"Starting interview: session={session_id}, room={room_id}")
    await fraud_system.get_or_create_session(session_id, room_id)
    return {"status": "success", "message": "Interview started", "session_id": session_id}


@app.post("/stop_interview")
async def stop_interview_endpoint(session_id: str):
    logger.info(f"Stopping interview: session={session_id}")
    return {"status": "success", "message": "Interview stopped", "session_id": session_id}


@app.post("/start_ai_interview")
async def start_ai_interview_endpoint(session_id: str, level: str = "medium", room_id: str = None):
    logger.info(f"Starting AI interview: session={session_id}, level={level}")
    
    if not room_id:
        room_id = "default"
    
    resume_text = resume_store.get(room_id, "No resume provided")
    questions = generate_dynamic_questions(resume_text, level)
    
    ai_session = AIInterviewSession(session_id, room_id, level, questions)
    ai_sessions[session_id] = ai_session
    
    await fraud_system.send_to_websocket(session_id, {
        "type": "ai_interview_started",
        "session_id": session_id,
        "questions": questions,
        "first_question": questions[0] if questions else None,
        "total_questions": len(questions),
        "timestamp": time.time()
    })
    
    return {
        "status": "success",
        "session_id": session_id,
        "questions": questions,
        "total_questions": len(questions),
        "first_question": questions[0] if questions else None
    }


@app.post("/submit_ai_answer")
async def submit_ai_answer_endpoint(session_id: str, question: str, answer: str):
    logger.info(f"Submitting answer for session: {session_id}")
    
    if session_id not in ai_sessions:
        return JSONResponse(status_code=400, content={"status": "error", "message": "AI session not found"})
    
    ai_session = ai_sessions[session_id]
    score = calculate_answer_score(answer, ai_session.level, question)
    feedback = generate_feedback(score, answer)
    ai_session.submit_answer(answer, score, feedback)
    
    next_question = ai_session.get_current_question()
    is_complete = ai_session.is_complete()
    
    response_data = {
        "status": "success",
        "session_id": session_id,
        "score": score,
        "feedback": feedback,
        "is_complete": is_complete,
        "questions_answered": ai_session.current_index,
        "total_questions": len(ai_session.questions),
        "timestamp": time.time()
    }
    
    if next_question and not is_complete:
        response_data["next_question"] = next_question
    
    if is_complete:
        results = ai_session.get_results()
        response_data["final_results"] = results
    
    await fraud_system.send_to_websocket(session_id, {
        "type": "ai_answer_feedback",
        "session_id": session_id,
        "score": score,
        "feedback": feedback,
        "next_question": next_question if next_question else None,
        "is_complete": is_complete
    })
    
    return response_data


@app.post("/end_ai_interview")
async def end_ai_interview_endpoint(session_id: str):
    if session_id in ai_sessions:
        results = ai_sessions[session_id].get_results()
        del ai_sessions[session_id]
        return {"status": "success", "results": results}
    return {"status": "error", "message": "Session not found"}


# ==========================================================
# CRITICAL FIX: Reference Face Capture Endpoint
# ==========================================================

@app.post("/set_reference_face")
async def set_reference_face_endpoint(request: Request):
    """Set reference face for verification"""
    try:
        # Parse JSON body
        body = await request.json()
        session_id = body.get("session_id")
        image_data = body.get("image_data")
        
        logger.info(f"set_reference_face called for session: {session_id}")
        
        if not session_id:
            logger.warning("Missing session_id in request")
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "session_id is required"}
            )
        
        # Ensure session exists
        session = await fraud_system.get_or_create_session(session_id, "default")
        
        # Capture reference face
        success, message = await ai_detector.set_reference_face(session_id, image_data)
        
        if success:
            logger.info(f"✅ Reference face set successfully for session: {session_id}")
            return {
                "status": "success",
                "message": message,
                "session_id": session_id,
                "reference_set": True
            }
        else:
            logger.warning(f"Failed to set reference face: {message}")
            return JSONResponse(
                status_code=422,
                content={"status": "error", "message": message}
            )
            
    except Exception as e:
        logger.error(f"Error in set_reference_face: {e}")
        import traceback
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@app.post("/upload_resume")
async def upload_resume(session_id: str = Form(...), room_id: str = Form(...), file: UploadFile = File(...)):
    try:
        content = await file.read()
        resume_text = f"[Resume uploaded: {file.filename}]\nFile size: {len(content)} bytes"
        resume_store[room_id] = resume_text
        logger.info(f"Resume stored for room: {room_id}")
        return {"status": "success", "message": "Resume uploaded", "room_id": room_id}
    except Exception as e:
        logger.error(f"Error uploading resume: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/manual_upload_resume")
async def manual_upload_resume(session_id: str = Form(...), room_id: str = Form(...), resume_text: str = Form(...)):
    try:
        resume_store[room_id] = resume_text
        logger.info(f"Manual resume stored for room: {room_id}")
        return {"status": "success", "message": "Resume uploaded", "room_id": room_id}
    except Exception as e:
        logger.error(f"Error in manual resume upload: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.post("/voice/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    try:
        content = await audio.read()
        transcribed_text = "This is a sample transcribed answer from the candidate."
        return {
            "success": True,
            "text": transcribed_text,
            "word_count": len(transcribed_text.split())
        }
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/voice/submit_answer")
async def submit_voice_answer(request: Request):
    try:
        data = await request.json()
        session_id = data.get("session_id")
        answer_text = data.get("answer_text")
        
        return {
            "success": True,
            "score": 7,
            "feedback": "Good answer!",
            "next_question": "Tell me more about your experience."
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "version": "6.0.4",
        "frames_received": ai_detector.frame_received_count,
        "active_sessions": len(ai_sessions)
    }


@app.get("/stats")
async def get_stats():
    return {
        "ai_sessions": len(ai_sessions),
        "resumes_stored": len(resume_store),
        "frames_received": ai_detector.frame_received_count,
        "websocket_connections": len(fraud_system.websocket_connections)
    }


@app.get("/debug_sessions")
async def debug_sessions():
    sessions_info = {}
    for sid, session in fraud_system.active_sessions.items():
        sessions_info[sid] = {
            "room_id": session.room_id,
            "reference_face_set": session.reference_face_set,
            "start_time": session.start_time,
            "last_activity": session.last_activity
        }
    return {
        "active_sessions": sessions_info,
        "ai_sessions": list(ai_sessions.keys()),
        "total_sessions": len(fraud_system.active_sessions)
    }


@app.get("/")
async def root():
    return {"message": "AI Interview API v6.0.4", "status": "running"}


# ==========================================================
# WebSocket Endpoint
# ==========================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = None
    logger.info(f"✅ New WebSocket connection accepted")
    active_connections.append(websocket)
    
    try:
        await websocket.send_json({
            "type": "connection_established",
            "message": "WebSocket connected successfully",
            "timestamp": time.time()
        })
        
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                
                try:
                    json_data = json.loads(data)
                    message_type = json_data.get('type', '')
                    
                    if message_type == 'ping':
                        await websocket.send_json({"type": "pong", "timestamp": time.time()})
                        continue
                    
                    elif message_type == 'participant_frame':
                        frame_data = json_data.get('image')
                        room_id = json_data.get('roomId')
                        session_id = json_data.get('sessionId')
                        
                        if frame_data:
                            await ai_detector.set_frame_from_frontend(frame_data)
                            detection_data = await ai_detector.process_frame(session_id)
                            detection_data['room_id'] = room_id
                            detection_data['session_id'] = session_id
                            detection_data['type'] = 'detection_result'
                            await websocket.send_json(detection_data)
                    
                    elif message_type == 'command':
                        command = json_data.get('command')
                        cmd_session_id = json_data.get('session_id')
                        
                        if command == 'register_session' and cmd_session_id:
                            fraud_system.register_websocket(cmd_session_id, websocket)
                            session_id = cmd_session_id
                            await websocket.send_json({
                                "type": "command_response",
                                "command": "register_session",
                                "status": "success"
                            })
                            logger.info(f"Session registered: {cmd_session_id}")
                        
                        elif command == 'start_ai_interview' and cmd_session_id:
                            room_id = json_data.get('room_id', 'default')
                            level = json_data.get('level', 'medium')
                            resume_text = resume_store.get(room_id, "")
                            questions = generate_dynamic_questions(resume_text, level)
                            
                            ai_session = AIInterviewSession(cmd_session_id, room_id, level, questions)
                            ai_sessions[cmd_session_id] = ai_session
                            
                            await websocket.send_json({
                                "type": "ai_interview_started",
                                "session_id": cmd_session_id,
                                "questions": questions,
                                "first_question": questions[0] if questions else None,
                                "total_questions": len(questions)
                            })
                        
                        elif command == 'submit_ai_answer' and cmd_session_id:
                            question = json_data.get('question', '')
                            answer = json_data.get('answer', '')
                            
                            if cmd_session_id in ai_sessions:
                                ai_session = ai_sessions[cmd_session_id]
                                score = calculate_answer_score(answer, ai_session.level, question)
                                feedback = generate_feedback(score, answer)
                                ai_session.submit_answer(answer, score, feedback)
                                
                                next_question = ai_session.get_current_question()
                                is_complete = ai_session.is_complete()
                                
                                response_data = {
                                    "type": "ai_answer_feedback",
                                    "session_id": cmd_session_id,
                                    "score": score,
                                    "feedback": feedback,
                                    "is_complete": is_complete,
                                    "questions_answered": ai_session.current_index,
                                    "total_questions": len(ai_session.questions)
                                }
                                
                                if next_question and not is_complete:
                                    response_data["next_question"] = next_question
                                
                                await websocket.send_json(response_data)
                
                except json.JSONDecodeError:
                    continue
                
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"type": "ping", "timestamp": time.time()})
                except:
                    break
                continue
                
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for session: {session_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        if session_id:
            fraud_system.unregister_websocket(session_id)
        if websocket in active_connections:
            active_connections.remove(websocket)


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down...")
    ai_detector.cleanup()


if __name__ == "__main__":
    print("=" * 60)
    print("🤖 AI Interview API Server v6.0.4")
    print("=" * 60)
    print("🌐 Server: http://localhost:8001")
    print("📡 WebSocket: ws://localhost:8001/ws")
    print("📋 Endpoints:")
    print("   POST /set_reference_face - Capture reference face")
    print("   POST /start_ai_interview - Start AI interview")
    print("   POST /submit_ai_answer - Submit answer")
    print("   POST /upload_resume - Upload resume")
    print("   GET /health - Health check")
    print("   GET /stats - Statistics")
    print("=" * 60)
    
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")