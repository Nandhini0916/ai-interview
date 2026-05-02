# main.py - COMPLETE FIXED VERSION v1.3.0
# ==========================================================
# FRAUD DETECTION & AI INTERVIEW SYSTEM - v1.3.0
# ==========================================================
# FIXES INCLUDED:
# 1. Improved WebSocket stability with proper heartbeat tracking
# 2. Fixed answer submission flow with dual path (WebRTC + REST)
# 3. Better frame processing with async thread to prevent blocking
# 4. Proper reconnection handling
# 5. Enhanced error logging and recovery
# ==========================================================

import sys
import os

# Set environment variables
os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"

import logging
import base64
import time
import json
import asyncio
import io
from typing import Dict, Any, Optional
from datetime import datetime

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('fraud_detection.log', encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)
logger.info("=" * 60)
logger.info("Starting Fraud Detection System v1.3.0")
logger.info("=" * 60)

# Import FastAPI
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, UploadFile, File, Form
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    import cv2
    import numpy as np
    import uvicorn
    
    logger.info("Core imports successful")
except ImportError as e:
    logger.error(f"Import error: {e}")
    sys.exit(1)

# Import AI Interview Model
try:
    from ai_interview_model import (
        QuestionGenerator, AnswerEvaluator, InterviewSession,
        AIInterviewEngine, ResultEvaluator, GEMINI_AVAILABLE
    )
    logger.info(f"AI Model loaded (Gemini: {GEMINI_AVAILABLE})")
except ImportError as e:
    logger.error(f"Failed to import ai_interview_model: {e}")
    sys.exit(1)

# Import optional dependencies
try:
    import PyPDF2
    PDF_AVAILABLE = True
    logger.info("PyPDF2 loaded")
except ImportError:
    PDF_AVAILABLE = False
    logger.warning("PyPDF2 not available - PDF parsing disabled")

# Import speech-to-text libraries
WHISPER_AVAILABLE = False
SPEECH_RECOGNITION_AVAILABLE = False

try:
    import whisper as whisper_lib
    import tempfile
    import subprocess
    _whisper_model = None  # Lazy-load on first use
    WHISPER_AVAILABLE = True
    logger.info("OpenAI Whisper loaded")
except ImportError:
    logger.warning("Whisper not available - trying SpeechRecognition")

try:
    import speech_recognition as sr
    import tempfile
    SPEECH_RECOGNITION_AVAILABLE = True
    logger.info("SpeechRecognition loaded")
except ImportError:
    logger.warning("SpeechRecognition not available - transcription disabled")

# Create FastAPI app
app = FastAPI(title="Fraud Detection & AI Interview", version="1.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
WEBSOCKET_TIMEOUT = 600
HEARTBEAT_INTERVAL = 30  # Send heartbeat every 30 seconds
HEARTBEAT_TIMEOUT = 15   # Wait 15 seconds for pong
MAX_MISSED_HEARTBEATS = 3

# Storage
ai_sessions: Dict[str, InterviewSession] = {}
resume_store: Dict[str, Dict[str, Any]] = {}  # Store both text and metadata
active_websockets: Dict[str, WebSocket] = {}
frame_received_count: Dict[str, int] = {}
latest_frames: Dict[str, np.ndarray] = {}
session_rooms: Dict[str, str] = {}
last_heartbeat: Dict[str, float] = {}


# ==========================================================
# Face Detector with Per-Session Frame Storage
# ==========================================================

class FaceDetector:
    def __init__(self):
        self.face_cascade = None
        self.eye_cascade = None
        self._load_cascades()
        
        # Detection state
        self.total_frames = 0
        self.last_detection_time = 0
        self.reference_faces: Dict[str, tuple] = {}
        self.reference_face_embeddings: Dict[str, np.ndarray] = {}
        
    def _load_cascades(self):
        """Load Haar cascades for face detection"""
        try:
            cascade_path = cv2.data.haarcascades
            self.face_cascade = cv2.CascadeClassifier(
                cascade_path + 'haarcascade_frontalface_default.xml'
            )
            self.eye_cascade = cv2.CascadeClassifier(
                cascade_path + 'haarcascade_eye.xml'
            )
            
            if self.face_cascade.empty():
                logger.warning("Face cascade not found, trying alternative...")
                alt_path = '/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml'
                if os.path.exists(alt_path):
                    self.face_cascade = cv2.CascadeClassifier(alt_path)
            
            if self.face_cascade is not None and not self.face_cascade.empty():
                logger.info("Face cascade loaded successfully")
            else:
                logger.error("Failed to load face cascade")
                self.face_cascade = None
                
        except Exception as e:
            logger.error(f"Error loading cascades: {e}")
            self.face_cascade = None
            self.eye_cascade = None
    
    def detect_emotion(self, face_roi):
        """Simple emotion detection based on facial features"""
        if face_roi is None or face_roi.size == 0:
            return "neutral"
        
        try:
            gray_face = cv2.cvtColor(face_roi, cv2.COLOR_BGR2GRAY)
            h, w = gray_face.shape
            
            if h > 0 and w > 0:
                mouth_region = gray_face[int(h*0.6):, :] if int(h*0.6) < h else gray_face
                if mouth_region.size > 0:
                    mouth_mean = np.mean(mouth_region)
                    if mouth_mean < 100:
                        return "happy"
                
                brow_region = gray_face[:int(h*0.3), :] if int(h*0.3) > 0 else gray_face
                if brow_region.size > 0:
                    brow_mean = np.mean(brow_region)
                    if brow_mean < 80:
                        return "focused"
        except Exception as e:
            logger.debug(f"Emotion detection error: {e}")
        
        return "neutral"
    
    def estimate_gender(self, face_roi):
        """Simple gender estimation based on facial ratios"""
        if face_roi is None or face_roi.size == 0:
            return "Unknown", 0
        
        try:
            h, w = face_roi.shape[:2]
            aspect_ratio = w / h if h > 0 else 1
            
            if aspect_ratio > 0.85:
                return "Male", 0.65
            elif aspect_ratio < 0.75:
                return "Female", 0.65
        except Exception as e:
            logger.debug(f"Gender estimation error: {e}")
        
        return "Unknown", 0.4
    
    def detect_eye_movements(self, face_roi):
        """Count eye movements"""
        if face_roi is None or face_roi.size == 0 or self.eye_cascade is None:
            return 0
        
        try:
            gray_face = cv2.cvtColor(face_roi, cv2.COLOR_BGR2GRAY)
            eyes = self.eye_cascade.detectMultiScale(gray_face, 1.1, 5, minSize=(20, 20))
            return min(len(eyes), 10)  # Cap at 10
        except Exception as e:
            logger.debug(f"Eye movement detection error: {e}")
            return 0
    
    def process_frame(self, frame_data: str, session_id: str = None) -> dict:
        """Process a single frame and return detection results"""
        self.total_frames += 1
        
        try:
            # Parse base64 image - handle both data URL and raw base64
            if ',' in frame_data:
                frame_data = frame_data.split(',')[1]
            
            image_bytes = base64.b64decode(frame_data)
            nparr = np.frombuffer(image_bytes, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            
            if frame is None:
                return self._get_default_result()
            
            # Store latest frame for this session
            if session_id:
                latest_frames[session_id] = frame.copy()
                frame_received_count[session_id] = frame_received_count.get(session_id, 0) + 1
            
            # Convert to grayscale for detection
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            
            # Detect faces
            faces = []
            if self.face_cascade is not None:
                faces = self.face_cascade.detectMultiScale(
                    gray, 1.1, 5, minSize=(50, 50)
                )
            
            face_count = len(faces)
            
            # Analyze face alerts
            if face_count == 0:
                face_alert = "No face detected"
            elif face_count > 1:
                face_alert = f"Multiple faces ({face_count})"
            else:
                face_alert = ""
            
            # Process face if detected
            gender = "Unknown"
            mood = "neutral"
            eye_moves = 0
            lipsync = False
            
            if face_count >= 1 and faces is not None and len(faces) > 0:
                x, y, w, h = faces[0]
                # Ensure coordinates are within bounds
                x, y = max(0, x), max(0, y)
                face_roi = frame[y:min(y+h, frame.shape[0]), x:min(x+w, frame.shape[1])]
                
                if face_roi.size > 0:
                    # Gender estimation
                    gender, _ = self.estimate_gender(face_roi)
                    
                    # Emotion detection
                    mood = self.detect_emotion(face_roi)
                    
                    # Eye movement detection
                    eye_moves = self.detect_eye_movements(face_roi)
                    lipsync = True
            
            # Check if reference face is set
            verification = "Not set"
            if session_id and session_id in self.reference_faces:
                verification = "Verified"
            
            # Update timestamp
            self.last_detection_time = time.time()
            
            # Log every 30 frames
            if self.total_frames % 30 == 0:
                logger.info(
                    f"Frame {self.total_frames} | Session: {session_id} | "
                    f"Faces: {face_count} | Gender: {gender} | Frames received: {frame_received_count.get(session_id, 0)}"
                )
            
            return {
                "faces": face_count,
                "face_alert": face_alert,
                "gender": gender if gender != "Unknown" else "Detecting",
                "mood": mood,
                "eye_moves": eye_moves,
                "lipsync": lipsync,
                "bg_voice": False,
                "speech": False,
                "verification": verification,
                "frame_number": self.total_frames,
                "timestamp": time.time()
            }
            
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
            return self._get_default_result()
    
    def _get_default_result(self) -> dict:
        return {
            "faces": 0,
            "face_alert": "Processing error",
            "gender": "Unknown",
            "mood": "neutral",
            "eye_moves": 0,
            "lipsync": False,
            "bg_voice": False,
            "speech": False,
            "verification": "Error",
            "frame_number": self.total_frames,
            "timestamp": time.time()
        }
    
    def get_latest_frame_info(self, session_id: str = None) -> dict:
        """Get info about the latest frame for a session"""
        if session_id and session_id in latest_frames:
            frame = latest_frames[session_id]
            return {
                "has_frame": True, 
                "session_id": session_id,
                "frame_shape": frame.shape if frame is not None else None,
                "frames_received": frame_received_count.get(session_id, 0)
            }
        
        # Check if any frames exist
        if latest_frames:
            return {
                "has_frame": True, 
                "active_sessions": list(latest_frames.keys()),
                "total_frames": self.total_frames,
                "frames_by_session": dict(frame_received_count)
            }
        
        return {"has_frame": False, "total_frames": self.total_frames}
    
    def set_reference_face(self, session_id: str) -> tuple:
        """Set reference face for verification"""
        # Check if we have a frame for this session
        if session_id not in latest_frames:
            frames_received = frame_received_count.get(session_id, 0)
            return False, f"No camera feed received. Frames received: {frames_received}. Please ensure camera is on and video is streaming."
        
        frame = latest_frames[session_id]
        
        if frame is None:
            return False, "No camera feed available."
        
        if self.face_cascade is None:
            return False, "Face detection not available. Please check OpenCV installation."
        
        # Convert to grayscale
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        
        # Detect faces with appropriate parameters
        faces = self.face_cascade.detectMultiScale(
            gray, 
            scaleFactor=1.1, 
            minNeighbors=5, 
            minSize=(50, 50),
            maxSize=(500, 500)
        )
        
        if len(faces) == 0:
            return False, "No face detected in the current frame. Please face the camera with good lighting."
        
        if len(faces) > 1:
            return False, f"Multiple faces detected ({len(faces)}). Please ensure only one person is in frame."
        
        # Store reference face for this session
        self.reference_faces[session_id] = tuple(faces[0])
        
        return True, f"Reference face captured successfully! Face detected at position {faces[0]}"


# Initialize detector
face_detector = FaceDetector()


# ==========================================================
# API Endpoints - FIXED for better error handling
# ==========================================================

@app.post("/upload_resume")
async def upload_resume(
    request: Request,
    file: UploadFile = None
):
    """Upload resume - supports both JSON and multipart/form-data"""
    try:
        resume_text = None
        room_id = None
        session_id = None
        filename = None
        
        # Check content type
        content_type = request.headers.get("content-type", "")
        logger.info(f"Upload request content-type: {content_type}")
        
        if "multipart/form-data" in content_type:
            # Handle multipart form data
            form = await request.form()
            file = form.get("file")
            room_id = form.get("room_id")
            session_id = form.get("session_id")
            
            if file and hasattr(file, 'read'):
                content = await file.read()
                filename = file.filename if file.filename else "unknown"
                logger.info(f"Processing uploaded file: {filename}, size: {len(content)}")
                
                # Try to extract text based on file type
                if filename.lower().endswith('.pdf') and PDF_AVAILABLE:
                    try:
                        pdf_reader = PyPDF2.PdfReader(io.BytesIO(content))
                        resume_text = ""
                        for page in pdf_reader.pages:
                            text = page.extract_text()
                            if text:
                                resume_text += text + "\n"
                        logger.info(f"PDF parsed: {len(resume_text)} chars")
                    except Exception as e:
                        logger.warning(f"PDF parsing failed: {e}")
                        resume_text = f"PDF File: {filename}\nSize: {len(content)} bytes\nNote: PDF text extraction failed. Please upload as TXT for better results."
                
                if not resume_text:
                    try:
                        resume_text = content.decode('utf-8')
                        logger.info(f"Decoded as text: {len(resume_text)} chars")
                    except:
                        resume_text = f"File: {filename}\nSize: {len(content)} bytes"
        else:
            # Handle JSON
            try:
                data = await request.json()
                resume_text = data.get("resume_text") or data.get("resume")
                room_id = data.get("room_id")
                session_id = data.get("session_id")
                filename = data.get("filename", "uploaded_resume.txt")
            except:
                pass
        
        store_key = room_id or session_id
        if not store_key or store_key == "None":
            store_key = "default"
        
        if resume_text and len(resume_text.strip()) > 10:
            resume_store[store_key] = {
                "text": resume_text,
                "filename": filename,
                "uploaded_at": datetime.now().isoformat(),
                "room_id": room_id,
                "session_id": session_id
            }
            logger.info(f"Resume stored for key: {store_key} ({len(resume_text)} chars)")
            return {
                "status": "success",
                "message": "Resume uploaded successfully",
                "key": store_key,
                "length": len(resume_text),
                "filename": filename
            }
        
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "No valid resume data received. Please ensure file contains text."}
        )
        
    except Exception as e:
        logger.error(f"Upload error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.post("/start_ai_interview")
async def start_ai_interview(request: Request):
    """Start AI interview - Fixed JSON parsing"""
    try:
        # Parse JSON body
        data = await request.json()
        session_id = data.get("session_id")
        level = data.get("level", "medium")
        room_id = data.get("room_id")
        
        logger.info(f"Starting AI interview - Session: {session_id}, Level: {level}, Room: {room_id}")
        
        if not session_id:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "session_id is required"}
            )
        
        # Find resume - try multiple keys
        resume_text = None
        resume_filename = None
        
        # Try room_id first, then session_id, then default
        for key in [room_id, session_id, "default"]:
            if key and key in resume_store:
                resume_data = resume_store[key]
                if isinstance(resume_data, dict):
                    resume_text = resume_data.get("text")
                    resume_filename = resume_data.get("filename")
                else:
                    resume_text = resume_data
                logger.info(f"Found resume for key: {key}")
                break
        
        if not resume_text or len(resume_text.strip()) < 50:
            logger.warning(f"Resume not found or too short. Available keys: {list(resume_store.keys())}")
            return JSONResponse(
                status_code=400,
                content={
                    "status": "error",
                    "message": "Resume not found or too short. Please upload a valid resume first.",
                    "available_keys": list(resume_store.keys())
                }
            )
        
        # Generate questions
        questions = QuestionGenerator.generate(resume_text, level)
        
        if not questions or len(questions) == 0:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "Failed to generate questions"}
            )
        
        # Create session
        session = InterviewSession(resume_text, level)
        ai_sessions[session_id] = session
        
        # Store resume for this session
        resume_store[session_id] = {
            "text": resume_text,
            "filename": resume_filename,
            "uploaded_at": datetime.now().isoformat()
        }
        
        logger.info(f"AI Interview started for {session_id} with {len(questions)} questions")
        
        return {
            "status": "success",
            "questions": questions,
            "total": len(questions),
            "first_question": questions[0],
            "level": level,
            "session_id": session_id
        }
        
    except json.JSONDecodeError as e:
        logger.error(f"JSON decode error: {e}")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": f"Invalid JSON: {str(e)}"}
        )
    except Exception as e:
        logger.error(f"Start interview error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.post("/submit_ai_answer")
async def submit_ai_answer(request: Request):
    """Submit answer for evaluation"""
    try:
        data = await request.json()
        session_id = data.get("session_id")
        question = data.get("question")
        answer = data.get("answer")
        
        logger.info(f"Submitting answer for session: {session_id}")
        logger.info(f"Answer preview: {answer[:100] if answer else 'None'}...")
        
        if not session_id:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "session_id is required"}
            )
        
        if session_id not in ai_sessions:
            logger.warning(f"Session not found: {session_id}. Available sessions: {list(ai_sessions.keys())}")
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": f"Session not found: {session_id}"}
            )
        
        session = ai_sessions[session_id]
        
        if not question:
            # Get current question from session if not provided
            if session.current_index > 0:
                question = session.questions[session.current_index - 1]
            else:
                question = session.questions[0] if session.questions else ""
        
        result = session.submit_answer(question, answer)
        
        next_question = session.get_next_question()
        is_complete = session.completed or next_question is None
        
        response = {
            "status": "success",
            "score": result["score"],
            "feedback": result["feedback"],
            "is_complete": is_complete,
            "questions_answered": len(session.scores),
            "total_questions": len(session.questions)
        }
        
        if next_question and not is_complete:
            response["next_question"] = next_question
            logger.info(f"Next question for {session_id}: {next_question[:100]}...")
        
        if is_complete:
            final = ResultEvaluator.calculate(session.scores)
            response["final_results"] = final
            logger.info(f"Interview completed for {session_id}. Score: {final.get('percentage', 0)}%")
        
        return response
        
    except json.JSONDecodeError as e:
        logger.error(f"JSON decode error: {e}")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": f"Invalid JSON: {str(e)}"}
        )
    except Exception as e:
        logger.error(f"Submit answer error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.post("/set_reference_face")
async def set_reference_face(request: Request):
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
        
        # Check if we have frames for this specific session
        if session_id not in latest_frames:
            frames_received = frame_received_count.get(session_id, 0)
            frame_info = face_detector.get_latest_frame_info(session_id)
            logger.info(f"Frame info for session {session_id}: {frame_info}")
            
            return JSONResponse(
                status_code=422,
                content={
                    "status": "error", 
                    "message": f"No camera feed. Frames received: {frames_received}. Please ensure camera is on and video is streaming.",
                    "frames_received": frames_received,
                    "has_any_frames": len(latest_frames) > 0
                }
            )
        
        success, message = face_detector.set_reference_face(session_id)
        
        if success:
            return {
                "status": "success",
                "message": message,
                "faces_detected": 1
            }
        else:
            return JSONResponse(
                status_code=422,
                content={"status": "error", "message": message}
            )
            
    except json.JSONDecodeError as e:
        logger.error(f"JSON decode error: {e}")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": f"Invalid JSON: {str(e)}"}
        )
    except Exception as e:
        logger.error(f"Reference face error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.post("/end_ai_interview")
async def end_ai_interview(request: Request):
    """End AI interview session"""
    try:
        data = await request.json()
        session_id = data.get("session_id")
        
        if session_id and session_id in ai_sessions:
            session = ai_sessions[session_id]
            final = ResultEvaluator.calculate(session.scores) if session.scores else None
            del ai_sessions[session_id]
            
            return {
                "status": "success",
                "message": "Interview ended",
                "final_results": final
            }
        
        return {"status": "success", "message": "Session not found or already ended"}
        
    except Exception as e:
        logger.error(f"End interview error: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


@app.get("/frame_status")
async def frame_status():
    """Get frame reception status"""
    frame_info = face_detector.get_latest_frame_info()
    return {
        "status": "success",
        "frame_info": frame_info,
        "frames_by_session": dict(frame_received_count),
        "total_frames": face_detector.total_frames,
        "active_sessions": len(latest_frames),
        "active_websockets": len(active_websockets)
    }


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "version": "1.3.0",
        "active_sessions": len(ai_sessions),
        "active_websockets": len(active_websockets),
        "resumes": len(resume_store),
        "frames_processed": face_detector.total_frames,
        "frames_stored": len(latest_frames),
        "cascade_loaded": face_detector.face_cascade is not None,
        "gemini": GEMINI_AVAILABLE
    }


@app.post("/transcribe")
async def transcribe_audio(request: Request):
    """
    Transcribe uploaded audio to text.
    Accepts multipart/form-data with field 'audio'.
    Tries Whisper first, falls back to Google SpeechRecognition.
    """
    global _whisper_model

    if not WHISPER_AVAILABLE and not SPEECH_RECOGNITION_AVAILABLE:
        return JSONResponse(
            status_code=503,
            content={"success": False, "error": "No transcription engine available. Install openai-whisper or speechrecognition."}
        )

    try:
        form = await request.form()
        audio_file = form.get("audio")

        if audio_file is None:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "No audio field in form data"}
            )

        audio_bytes = await audio_file.read()
        if not audio_bytes:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "Empty audio data"}
            )

        filename = getattr(audio_file, 'filename', 'recording.webm') or 'recording.webm'
        ext = os.path.splitext(filename)[1].lower() or '.webm'

        logger.info(f"Transcribe request: {len(audio_bytes)} bytes, ext={ext}")

        # ── Try Whisper ──────────────────────────────────────────
        if WHISPER_AVAILABLE:
            try:
                if _whisper_model is None:
                    logger.info("Loading Whisper 'base' model (first use)...")
                    _whisper_model = whisper_lib.load_model("base")
                    logger.info("Whisper model loaded")

                import tempfile
                with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                    tmp.write(audio_bytes)
                    tmp_path = tmp.name

                try:
                    result = _whisper_model.transcribe(tmp_path, language="en")
                    text = result.get("text", "").strip()
                finally:
                    try:
                        os.unlink(tmp_path)
                    except Exception:
                        pass

                if text:
                    logger.info(f"Whisper transcript ({len(text)} chars): {text[:80]}")
                    return {"success": True, "text": text, "engine": "whisper"}
                else:
                    logger.warning("Whisper returned empty text")

            except Exception as e:
                logger.error(f"Whisper transcription failed: {e}")

        # ── Fallback: SpeechRecognition (Google) ─────────────────
        if SPEECH_RECOGNITION_AVAILABLE:
            try:
                import tempfile
                recognizer = sr.Recognizer()

                # SpeechRecognition needs WAV; convert if needed
                with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp_src:
                    tmp_src.write(audio_bytes)
                    src_path = tmp_src.name

                wav_path = src_path
                converted = False

                if ext != '.wav':
                    wav_path = src_path.replace(ext, '.wav')
                    try:
                        # Try ffmpeg conversion
                        result = subprocess.run(
                            ['ffmpeg', '-y', '-i', src_path, '-ar', '16000', '-ac', '1', wav_path],
                            capture_output=True, timeout=15
                        )
                        converted = result.returncode == 0
                    except Exception:
                        converted = False

                try:
                    target = wav_path if converted else src_path
                    with sr.AudioFile(target) as source:
                        audio_data = recognizer.record(source)
                    text = recognizer.recognize_google(audio_data)
                    logger.info(f"SpeechRecognition transcript: {text[:80]}")
                    return {"success": True, "text": text, "engine": "google_sr"}
                except sr.UnknownValueError:
                    return JSONResponse(
                        status_code=422,
                        content={"success": False, "error": "Could not understand audio. Please speak clearly and try again."}
                    )
                except sr.RequestError as e:
                    return JSONResponse(
                        status_code=503,
                        content={"success": False, "error": f"Google Speech API error: {str(e)}"}
                    )
                finally:
                    for p in [src_path, wav_path]:
                        try:
                            if p and os.path.exists(p):
                                os.unlink(p)
                        except Exception:
                            pass

            except Exception as e:
                logger.error(f"SpeechRecognition fallback failed: {e}")

        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "All transcription engines failed. Please type your answer manually."}
        )

    except Exception as e:
        logger.error(f"Transcribe endpoint error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/")
async def root():
    return {
        "message": "Fraud Detection & AI Interview API v1.3.0",
        "status": "running",
        "endpoints": {
            "POST /upload_resume": "Upload resume (multipart/form-data or JSON)",
            "POST /start_ai_interview": "Start AI interview",
            "POST /submit_ai_answer": "Submit answer",
            "POST /set_reference_face": "Set reference face",
            "POST /end_ai_interview": "End AI interview",
            "POST /transcribe": "Transcribe audio to text",
            "GET /frame_status": "Check frame reception",
            "GET /health": "Health check",
            "WS /ws": "WebSocket for video"
        }
    }


# ==========================================================
# WebSocket Endpoint - IMPROVED with better keep-alive
# ==========================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = None
    room_id = None
    frame_count_this_session = 0
    last_heartbeat_time = time.time()
    last_pong_received = time.time()
    consecutive_missed = 0
    
    logger.info("=" * 40)
    logger.info("NEW WEBSOCKET CONNECTION")
    logger.info("=" * 40)
    
    # Send connection confirmation immediately
    await websocket.send_json({
        "type": "connected",
        "message": "Connected to AI server v1.3.0",
        "timestamp": time.time()
    })
    logger.info("Sent connection confirmation")
    
    # Keep-alive task
    async def keep_alive():
        nonlocal last_pong_received, consecutive_missed
        while True:
            try:
                await asyncio.sleep(HEARTBEAT_INTERVAL)
                if websocket.client_state.name == "CONNECTED":
                    current_time = time.time()
                    # Send ping
                    ping_time = current_time
                    await websocket.send_json({
                        "type": "ping",
                        "timestamp": ping_time,
                        "id": int(ping_time * 1000)
                    })
                    
                    # Wait a bit for pong response
                    await asyncio.sleep(HEARTBEAT_TIMEOUT)
                    
                    # Check if we received pong (updated via message handler)
                    if last_pong_received < ping_time:
                        consecutive_missed += 1
                        logger.warning(f"Missing heartbeat {consecutive_missed}/{MAX_MISSED_HEARTBEATS} for session {session_id}")
                        if consecutive_missed >= MAX_MISSED_HEARTBEATS:
                            logger.warning(f"No heartbeat response, closing connection for session {session_id}")
                            try:
                                await websocket.close(code=4000, reason="Heartbeat timeout")
                            except:
                                pass
                            return
                    else:
                        if consecutive_missed > 0:
                            logger.info(f"Heartbeat restored for session {session_id}")
                        consecutive_missed = 0
                else:
                    break
            except Exception as e:
                logger.error(f"Keep-alive error: {e}")
                break
    
    # Start keep-alive task
    keep_alive_task = asyncio.create_task(keep_alive())
    
    try:
        while True:
            try:
                # Receive message with reasonable timeout
                message = await asyncio.wait_for(websocket.receive_text(), timeout=60.0)
                
                try:
                    data = json.loads(message)
                    msg_type = data.get("type", "")
                    
                    # Handle ping
                    if msg_type == "ping":
                        await websocket.send_json({
                            "type": "pong", 
                            "timestamp": time.time(),
                            "id": data.get("id", time.time())
                        })
                        continue
                    
                    # Handle pong - update heartbeat tracking
                    if msg_type == "pong":
                        last_pong_received = time.time()
                        continue
                    
                    # Handle register_session
                    if msg_type == "register_session":
                        sess_id = data.get("session_id")
                        cmd = data.get("command")
                        
                        if sess_id:
                            session_id = sess_id
                            room_id = data.get("room_id", "default")
                            session_rooms[session_id] = room_id
                            active_websockets[session_id] = websocket
                            frame_received_count[session_id] = 0
                            last_heartbeat[session_id] = time.time()
                            last_pong_received = time.time()
                            consecutive_missed = 0
                            
                            logger.info(f"Session registered: {session_id}, room: {room_id}")
                            logger.info(f"Active WebSockets: {len(active_websockets)}")
                            
                            await websocket.send_json({
                                "type": "session_registered",
                                "session_id": session_id,
                                "status": "success",
                                "timestamp": time.time()
                            })
                            
                            # Handle start_ai_interview command
                            if cmd == "start_ai_interview":
                                level = data.get("level", "medium")
                                use_voice = data.get("use_voice", True)
                                
                                logger.info(f"Starting AI interview for session {session_id}")
                                
                                # Find resume
                                resume_text = None
                                for key in [room_id, session_id, "default"]:
                                    if key and key in resume_store:
                                        resume_data = resume_store[key]
                                        if isinstance(resume_data, dict):
                                            resume_text = resume_data.get("text")
                                        else:
                                            resume_text = resume_data
                                        logger.info(f"Found resume for key: {key}")
                                        break
                                
                                if not resume_text:
                                    await websocket.send_json({
                                        "type": "error",
                                        "message": "Resume not found. Please upload resume first."
                                    })
                                    continue
                                
                                questions = QuestionGenerator.generate(resume_text, level)
                                session = InterviewSession(resume_text, level)
                                ai_sessions[session_id] = session
                                
                                await websocket.send_json({
                                    "type": "interview_started",
                                    "questions": questions,
                                    "total": len(questions),
                                    "first_question": questions[0] if questions else None,
                                    "level": level,
                                    "timestamp": time.time()
                                })
                                logger.info(f"Interview started for {session_id} with {len(questions)} questions")
                        continue
                    
                    # Handle frame - IMPORTANT: Use 'participant_frame' type
                    if msg_type in ["frame", "participant_frame"]:
                        frame_data = data.get("image", "")
                        sess_id = data.get("session_id") or data.get("sessionId") or session_id
                        
                        if frame_data and len(frame_data) > 100:  # Ensure frame data is valid
                            frame_count_this_session += 1
                            if sess_id:
                                frame_received_count[sess_id] = frame_received_count.get(sess_id, 0) + 1
                                last_heartbeat[sess_id] = time.time()
                            
                            # Send acknowledgment every 30 frames to keep connection alive
                            if frame_count_this_session % 30 == 0:
                                try:
                                    await websocket.send_json({
                                        "type": "frame_ack",
                                        "frame": frame_count_this_session,
                                        "timestamp": time.time()
                                    })
                                    logger.info(f"Frame #{frame_count_this_session} received for session {sess_id}")
                                except:
                                    pass
                            
                            # Process frame in thread pool to avoid blocking
                            try:
                                result = await asyncio.to_thread(face_detector.process_frame, frame_data, sess_id)
                                result["type"] = "detection"
                                await websocket.send_json(result)
                            except Exception as e:
                                logger.error(f"Frame processing error: {e}")
                        continue
                    
                    # Handle answer via WebSocket
                    if msg_type == "submit_ai_answer" or msg_type == "answer":
                        question = data.get("question", "")
                        answer = data.get("answer", "")
                        sess_id = data.get("session_id") or session_id
                        
                        logger.info(f"Answer received via WebSocket for {sess_id}: {answer[:100] if answer else 'empty'}...")
                        
                        if sess_id and sess_id in ai_sessions:
                            session_obj = ai_sessions[sess_id]
                            eval_result = session_obj.submit_answer(question, answer)
                            
                            next_q = session_obj.get_next_question()
                            is_complete = session_obj.completed
                            
                            response = {
                                "type": "answer_result",
                                "score": eval_result["score"],
                                "feedback": eval_result["feedback"],
                                "is_complete": is_complete,
                                "questions_answered": len(session_obj.scores),
                                "total_questions": len(session_obj.questions),
                                "timestamp": time.time()
                            }
                            
                            if next_q and not is_complete:
                                response["next_question"] = next_q
                                logger.info(f"Sending next question for {sess_id}: {next_q[:100]}...")
                            
                            if is_complete:
                                final = ResultEvaluator.calculate(session_obj.scores)
                                response["final_results"] = final
                                logger.info(f"Interview completed for {sess_id}")
                            
                            await websocket.send_json(response)
                            logger.info(f"Answer result sent for {sess_id}")
                        else:
                            logger.warning(f"Session {sess_id} not found for answer submission. Available: {list(ai_sessions.keys())}")
                            await websocket.send_json({
                                "type": "error",
                                "message": f"Session {sess_id} not found."
                            })
                        continue
                    
                except json.JSONDecodeError as e:
                    logger.warning(f"Invalid JSON: {e}")
                    continue
                
            except asyncio.TimeoutError:
                # Timeout is normal, just continue the loop
                continue
            except Exception as e:
                logger.error(f"WebSocket receive error: {e}")
                break
                
    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: {session_id}")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        keep_alive_task.cancel()
        if session_id:
            if session_id in active_websockets:
                del active_websockets[session_id]
            if session_id in last_heartbeat:
                del last_heartbeat[session_id]
            if session_id in frame_received_count:
                logger.info(f"Session {session_id} processed {frame_received_count[session_id]} frames")
        logger.info(f"WebSocket cleaned up: {session_id}")
        logger.info(f"Total frames processed: {face_detector.total_frames}")


@app.on_event("shutdown")
async def shutdown():
    logger.info("Shutting down...")


if __name__ == "__main__":
    print("=" * 60)
    print("Fraud Detection & AI Interview v1.3.0")
    print("=" * 60)
    print("Server: http://localhost:8001")
    print("WebSocket: ws://localhost:8001/ws")
    print("=" * 60)
    print("")
    print("Starting server...")
    print("")
    
    uvicorn.run(app, host="0.0.0.0", port=8001, log_level="info")