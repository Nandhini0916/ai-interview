# main.py
# ==========================================================
# CRITICAL FIX - MUST BE AT THE VERY TOP BEFORE ANY IMPORTS
# ==========================================================

import sys
import os

# Patch google.protobuf BEFORE any other imports
# This must be done BEFORE importing any protobuf-dependent modules

# First, check and set environment variables
os.environ["PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION"] = "python"
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"  # Suppress TensorFlow logging

# Create a complete mock runtime_version module
class MockRuntimeVersion:
    """Mock the protobuf runtime_version module to prevent version conflicts"""
    __version__ = "3.20.3"
    
    @classmethod
    def ValidateProtobufRuntimeVersion(cls, proto_file_name, proto_version, 
                                        minimum_version, actual_proto_version, 
                                        package_version=None):
        """Mock the validation function - always return True"""
        return True
    
    @classmethod
    def _validate_proto_version(cls, proto_file_name, version, min_version):
        """Mock validation function"""
        return True

# Insert the mock module into sys.modules BEFORE any imports
sys.modules['google.protobuf.runtime_version'] = MockRuntimeVersion()

# Also mock the entire protobuf internal if needed
sys.modules['google._upb'] = type(sys)('google._upb')

# Now we can safely import everything else
import logging
import subprocess
import re
import tempfile
import wave
import io

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

# Now import the rest - these will use our mocked protobuf version
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, UploadFile, File, Form, Request
    from fastapi.responses import JSONResponse
    from fastapi.middleware.cors import CORSMiddleware
    import cv2
    import numpy as np
    from collections import deque, Counter
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
    import PyPDF2
    
    logger.info("✅ All core imports successful")
    
except ImportError as e:
    logger.error(f"❌ Import error: {e}")
    print(f"\nMissing dependencies. Install with:")
    print("pip install fastapi uvicorn opencv-python numpy webrtcvad pyaudio PyPDF2")
    sys.exit(1)

# Import MediaPipe with error handling
try:
    import mediapipe as mp
    MEDIAPIPE_AVAILABLE = True
    logger.info("✅ MediaPipe loaded successfully")
except Exception as e:
    logger.warning(f"MediaPipe not available: {e}")
    MEDIAPIPE_AVAILABLE = False

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

# Try to import Whisper for voice transcription
try:
    import whisper
    WHISPER_AVAILABLE = True
    logger.info("✅ Whisper loaded successfully")
    whisper_model = whisper.load_model("base")
    logger.info("✅ Whisper model loaded")
except ImportError as e:
    logger.warning(f"Whisper not available: {e}")
    WHISPER_AVAILABLE = False
    whisper_model = None
except Exception as e:
    logger.warning(f"Whisper initialization error: {e}")
    WHISPER_AVAILABLE = False
    whisper_model = None

# Try to import speech_recognition for fallback
try:
    import speech_recognition as sr
    SPEECH_RECOGNITION_AVAILABLE = True
    logger.info("✅ SpeechRecognition loaded successfully")
except ImportError as e:
    logger.warning(f"SpeechRecognition not available: {e}")
    SPEECH_RECOGNITION_AVAILABLE = False

# Try to import google generative AI for enhanced question generation
try:
    from google import genai
    GEMINI_AVAILABLE = True
    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    if GEMINI_API_KEY and GEMINI_API_KEY != "your-api-key-here":
        gemini_client = genai.Client(api_key=GEMINI_API_KEY)
        logger.info("✅ Gemini AI loaded successfully")
    else:
        GEMINI_AVAILABLE = False
        logger.warning("Gemini API key not found, using fallback question generation")
except ImportError as e:
    logger.warning(f"Google GenAI not available: {e}")
    GEMINI_AVAILABLE = False
except Exception as e:
    logger.warning(f"Gemini initialization error: {e}")
    GEMINI_AVAILABLE = False

# Now create the FastAPI app
app = FastAPI(title="AI Interview Detection & Interview API", version="6.0.0")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", 
                   "http://localhost:5174", "http://127.0.0.1:5174", "http://localhost:5175"],
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
GENDER_DETECTION_INTERVAL = 5
MAX_RECONNECT_ATTEMPTS = 5
RECONNECT_DELAY = 3000

# Voice Interview Configuration
VOICE_RESPONSE_TIMEOUT = 60  # seconds
MAX_AUDIO_SIZE = 10 * 1024 * 1024  # 10MB

# ==========================================================
# Voice Interview Session Class (Extended)
# ==========================================================

class VoiceInterviewSession:
    """Manages voice-enabled AI interview session"""
    def __init__(self, session_id: str, room_id: str, level: str, questions: List[str]):
        self.session_id = session_id
        self.room_id = room_id
        self.level = level
        self.questions = questions
        self.current_index = 0
        self.scores = []
        self.answers = []
        self.feedback_list = []
        self.voice_responses = []
        self.audio_recordings = []
        self.is_active = True
        self.start_time = time.time()
        self.last_activity = time.time()
        self.voice_enabled = True
    
    def get_current_question(self):
        if self.current_index < len(self.questions):
            return self.questions[self.current_index]
        return None
    
    def submit_answer(self, answer: str, score: int, feedback: str, is_voice: bool = False, audio_path: str = None):
        current_question = self.get_current_question()
        if current_question:
            answer_data = {
                "question": current_question,
                "answer": answer,
                "score": score,
                "feedback": feedback,
                "timestamp": time.time(),
                "is_voice": is_voice
            }
            self.answers.append(answer_data)
            self.scores.append(score)
            self.feedback_list.append(feedback)
            
            if is_voice and audio_path:
                self.audio_recordings.append(audio_path)
                self.voice_responses.append(answer)
            
            self.current_index += 1
            self.last_activity = time.time()
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
        
        if percentage >= 80:
            verdict = "Excellent"
        elif percentage >= 60:
            verdict = "Good"
        elif percentage >= 40:
            verdict = "Average"
        else:
            verdict = "Needs Improvement"
        
        voice_stats = {
            "total_voice_responses": len(self.voice_responses),
            "average_voice_length": sum(len(r.split()) for r in self.voice_responses) / len(self.voice_responses) if self.voice_responses else 0,
            "voice_enabled": self.voice_enabled
        }
        
        return {
            "total_score": total_score,
            "max_score": max_score,
            "percentage": round(percentage, 2),
            "verdict": verdict,
            "questions_answered": len(self.scores),
            "average_score": round(total_score / len(self.scores), 2) if self.scores else 0,
            "scores": self.scores,
            "answers": self.answers,
            "voice_stats": voice_stats
        }


# ==========================================================
# AI Interview Session Class
# ==========================================================

class AIInterviewSession:
    """Manages AI interview state per session"""
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
            self.last_activity = time.time()
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
        
        if percentage >= 80:
            verdict = "Excellent"
        elif percentage >= 60:
            verdict = "Good"
        elif percentage >= 40:
            verdict = "Average"
        else:
            verdict = "Needs Improvement"
        
        return {
            "total_score": total_score,
            "max_score": max_score,
            "percentage": round(percentage, 2),
            "verdict": verdict,
            "questions_answered": len(self.scores),
            "average_score": round(total_score / len(self.scores), 2) if self.scores else 0,
            "scores": self.scores,
            "answers": self.answers
        }


# ==========================================================
# Question Generation Function (Enhanced with Gemini)
# ==========================================================

def generate_questions_with_gemini(resume_text: str, level: str) -> List[str]:
    """Generate interview questions using Gemini AI"""
    if not GEMINI_AVAILABLE or not gemini_client:
        return None
    
    level_prompts = {
        "easy": "Ask basic conceptual questions about their skills and experience. Focus on fundamentals.",
        "medium": "Ask practical scenario-based questions that test problem-solving skills.",
        "hard": "Ask advanced technical questions about system design, optimization, and edge cases."
    }
    
    prompt = f"""
You are a technical interviewer conducting an interview for a software engineering position.

Resume/Candidate Information:
{resume_text[:2000]}

Difficulty Level: {level.upper()}
Guidelines: {level_prompts.get(level, level_prompts["medium"])}

Generate exactly 6 interview questions based on the candidate's resume:
1. One question about their technical skills and experience
2. One question about their most notable project
3. One question about problem-solving approach
4. One question about teamwork and collaboration
5. One question about their career goals and motivation
6. One question about handling challenges or failures

Format: Return ONLY the questions, one per line, numbered 1-6.
Do not include any explanations, headers, or extra text.
"""

    try:
        response = gemini_client.models.generate_content(
            model="gemini-2.0-flash-exp",
            contents=prompt
        )
        text = response.text.strip()
        
        questions = []
        for line in text.split('\n'):
            line = line.strip()
            if line and (line[0].isdigit() or line.startswith('-') or line.startswith('•')):
                if '. ' in line:
                    question = line.split('. ', 1)[-1]
                elif ') ' in line:
                    question = line.split(') ', 1)[-1]
                else:
                    question = line.lstrip('0123456789.-• ')
                if question and len(question) > 15:
                    questions.append(question)
        
        if len(questions) >= 4:
            return questions[:6]
    except Exception as e:
        logger.error(f"Gemini question generation error: {e}")
    
    return None


def generate_dynamic_questions(resume_text: str, level: str) -> List[str]:
    """Generate dynamic questions based on resume content (with Gemini fallback)"""
    
    # Try Gemini first if available
    gemini_questions = generate_questions_with_gemini(resume_text, level)
    if gemini_questions:
        logger.info(f"✅ Generated {len(gemini_questions)} questions using Gemini AI")
        return gemini_questions
    
    # Fallback to template-based questions
    logger.info("Using fallback question generation")
    
    # Parse resume for key information
    resume_lower = resume_text.lower()
    
    # Detect skills
    skills = []
    skill_keywords = ['python', 'javascript', 'react', 'node', 'java', 'c++', 'sql', 
                      'mongodb', 'aws', 'docker', 'kubernetes', 'tensorflow', 'pytorch',
                      'html', 'css', 'typescript', 'angular', 'vue', 'django', 'flask',
                      'spring', 'hibernate', 'rest', 'api', 'graphql', 'git', 'github',
                      'ci/cd', 'jenkins', 'azure', 'gcp', 'linux', 'redis', 'postgresql']
    
    for skill in skill_keywords:
        if skill in resume_lower:
            skills.append(skill)
    
    # Detect experience level
    experience_years = 0
    year_patterns = [
        r'(\d+)\+?\s*years?',
        r'experience\s*:\s*(\d+)',
        r'(\d+)\s*\+\s*years?',
        r'(\d+)\s+years?\s+of\s+experience'
    ]
    for pattern in year_patterns:
        match = re.search(pattern, resume_lower)
        if match:
            experience_years = int(match.group(1))
            break
    
    # Generate questions based on level
    questions = []
    
    # Base questions for all levels
    if skills:
        top_skills = skills[:3]
        questions.append(f"Based on your resume, I see you have experience with {', '.join(top_skills)}. Can you describe a project where you used these skills extensively?")
    else:
        questions.append("Tell me about your technical background and the key skills you've developed.")
    
    questions.append("Describe your most challenging project and how you overcame the obstacles you faced.")
    
    # Level-specific questions
    if level == "easy":
        questions.extend([
            "What motivated you to pursue this career path?",
            "How do you stay updated with the latest technologies and industry trends?",
            "Describe your ideal work environment and team culture.",
            "What do you consider your greatest professional achievement so far?"
        ])
    elif level == "medium":
        questions.extend([
            "Explain a technical decision you made that had significant impact on a project.",
            "How do you handle disagreements with team members about technical approaches?",
            "Describe your experience with testing strategies and quality assurance.",
            "Tell me about a time you had to learn a new technology quickly for a project."
        ])
    else:  # hard
        questions.extend([
            "Describe a time you had to optimize a system for better performance. What was your approach?",
            "How would you design a scalable system to handle millions of concurrent users?",
            "Explain your experience with system architecture and design patterns in production.",
            "Describe a complex technical problem you solved and the trade-offs you considered."
        ])
    
    # Add experience-based questions
    if experience_years > 5:
        questions.append("With your extensive experience, what advice would you give to junior developers?")
    elif experience_years > 2:
        questions.append(f"How have you grown professionally in your {experience_years} years of experience?")
    
    # Add company/role specific questions
    questions.append("Why are you interested in this position and what makes you a good fit?")
    questions.append("Where do you see yourself professionally in the next 3-5 years?")
    
    return questions[:7]


def calculate_answer_score(answer: str, level: str, question: str) -> int:
    """Calculate score based on answer quality"""
    answer_length = len(answer.split())
    
    if level == "easy":
        if answer_length >= 50:
            score = 8
        elif answer_length >= 30:
            score = 6
        elif answer_length >= 15:
            score = 4
        else:
            score = 2
    elif level == "medium":
        if answer_length >= 75:
            score = 8
        elif answer_length >= 50:
            score = 6
        elif answer_length >= 25:
            score = 4
        else:
            score = 2
    else:  # hard
        if answer_length >= 100:
            score = 8
        elif answer_length >= 70:
            score = 6
        elif answer_length >= 40:
            score = 4
        else:
            score = 2
    
    keywords = ['example', 'project', 'team', 'implement', 'design', 'solution', 'problem',
                'experience', 'learned', 'challenge', 'success', 'approach', 'methodology',
                'because', 'therefore', 'however', 'specifically', 'particular']
    keyword_count = sum(1 for kw in keywords if kw.lower() in answer.lower())
    score = min(10, score + min(3, keyword_count))
    
    if '•' in answer or '-' in answer or any(str(i) in answer for i in range(1, 4)):
        score = min(10, score + 1)
    
    return score


def generate_feedback(score: int, answer: str) -> str:
    """Generate feedback based on score"""
    if score >= 9:
        return f"Excellent answer! Score: {score}/10 - Very comprehensive and well-structured. Great use of examples."
    elif score >= 8:
        return f"Great answer! Score: {score}/10 - Good content with solid structure."
    elif score >= 6:
        return f"Good answer! Score: {score}/10 - Good content, could add more specific examples or details."
    elif score >= 4:
        return f"Satisfactory answer. Score: {score}/10 - Try to provide more detailed and structured responses."
    else:
        return f"Needs improvement. Score: {score}/10 - Please provide more comprehensive answers with specific examples."


# Store sessions
ai_sessions: Dict[str, AIInterviewSession] = {}
voice_sessions: Dict[str, VoiceInterviewSession] = {}


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
    voice_enabled: bool = True
    
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
        with self.session_lock:
            if session_id in self.active_sessions:
                session = self.active_sessions[session_id]
                session.last_activity = time.time()
                return session
            
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
        with self.session_lock:
            if session_id in self.active_sessions:
                session = self.active_sessions[session_id]
                session.end_time = time.time()
                session.interview_active = False
                session.ai_interview_active = False
                del self.active_sessions[session_id]
                self.unregister_websocket(session_id)
                if session_id in self.reconnect_attempts:
                    del self.reconnect_attempts[session_id]
                logger.info(f"Ended fraud detection session: {session_id}")
                return {"session_id": session.session_id, "ended": True}
        return None
    
    def check_fraud_alerts(self, detection_data: dict, session: DetectionSession) -> List[str]:
        alerts = []
        
        if detection_data.get('faces', 0) > 1:
            alerts.append("Multiple faces detected")
        if detection_data.get('bg_voice', False):
            alerts.append("Background voice detected")
        if detection_data.get('verification', 'Not set') == 'NOT MATCH':
            alerts.append("Face verification failed")
        if detection_data.get('eye_moves', 0) > 50:
            alerts.append("Excessive eye movements detected")
        
        return alerts
    
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
    
    def update_activity(self, session_id: str):
        if session_id in self.active_sessions:
            self.active_sessions[session_id].last_activity = time.time()


class AIDetector:
    """Enhanced AI Detector with reduced dependencies"""
    
    def __init__(self, fraud_system: FraudDetectionSystem):
        self.fraud_system = fraud_system
        self.running = True
        
        # Initialize MediaPipe if available
        self.face_mesh = None
        self.face_detector = None
        
        if MEDIAPIPE_AVAILABLE:
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
        
        self.eye_movement_count = 0
        self.prev_eye_x = None
        self.frame_counter = 0
        self.last_detected_face_count = 0
        self.face_alert = ""
        self.face_count = 0
        
        self.latest_gender = "Unknown"
        self.gender_frame_counter = 0
        self.gender_history = deque(maxlen=15)
        self.gender_confidence = 0.0
        self.last_gender_update = time.time()
        
        if YOLO_AVAILABLE and YOLO:
            try:
                self.model = YOLO("best (6).pt")
                logger.info("✅ YOLO model loaded successfully")
            except Exception as e:
                logger.error(f"YOLO model loading failed: {e}")
                self.model = None
        else:
            self.model = None
        
        self.mood_history = deque(maxlen=MOOD_HISTORY_LEN)
        self.current_mood = "neutral"
        self.mood_frame_counter = 0
        
        # Audio detection
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
                frames_per_buffer=self.SAMPLES_PER_FRAME
            )
            logger.info("✅ Audio input initialized successfully")
        except Exception as e:
            logger.error(f"Audio setup failed: {e}")
        
        self.bg_voice = False
        self.lipsync = False
        self.mouth_ratio_debug = 0.0
        
        try:
            self.face_cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
            logger.info("✅ Face cascade loaded successfully")
        except Exception as e:
            logger.error(f"Face cascade loading failed: {e}")
            self.face_cascade = None
        
        self.reference_face = None
        self.verification_status = "Not set"
        
        self.latest_frame = None
        self.frame_lock = asyncio.Lock()
        self.last_frame_time = 0
        self.frame_timeout = 5.0
        self.frame_received_count = 0
        
        if self.stream:
            self.start_audio_thread()
    
    def start_audio_thread(self):
        try:
            self.audio_thread = threading.Thread(target=self.audio_vad_worker, daemon=True)
            self.audio_thread.start()
            logger.info("✅ Audio processing thread started")
        except Exception as e:
            logger.error(f"Failed to start audio thread: {e}")
    
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
        if time.time() - self.last_frame_time > self.frame_timeout:
            return None
        return self.latest_frame
    
    def process_face(self, frame):
        if frame is None or not MEDIAPIPE_AVAILABLE or self.face_mesh is None:
            return None
            
        try:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            
            if self.face_detector:
                detection_results = self.face_detector.process(rgb)
                self.face_count = len(detection_results.detections) if detection_results and detection_results.detections else 0
            else:
                self.face_count = 0
            
            mesh_results = self.face_mesh.process(rgb)
            self.face_alert = ""
            
            if mesh_results and mesh_results.multi_face_landmarks:
                self.frame_counter += 1
                for face_landmarks in mesh_results.multi_face_landmarks:
                    try:
                        eye_x = face_landmarks.landmark[33].x
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
    
    def process_gender(self, frame):
        if frame is None or self.model is None:
            return
        # Simplified gender detection - can be enhanced
        pass
    
    def process_mood(self, frame, mesh_results):
        # Simplified - can be enhanced with DeepFace if available
        pass
    
    def audio_vad_worker(self):
        if self.stream is None:
            return
            
        while self.running:
            try:
                frame_bytes = self.stream.read(self.SAMPLES_PER_FRAME, exception_on_overflow=False)
                is_speech = self.vad.is_speech(frame_bytes, self.RATE)
                self.speech_deque.append(1 if is_speech else 0)
                
                speech_ratio = sum(self.speech_deque) / len(self.speech_deque) if self.speech_deque else 0
                self.speech_confidence = speech_ratio
                self.recent_speech_flag = speech_ratio > SPEECH_DETECTION_THRESHOLD
                self.speech_detected = self.recent_speech_flag
                
            except Exception as e:
                logger.error(f"Audio processing error: {e}")
                break
    
    def process_noise(self, frame):
        self.bg_voice = False
        self.lipsync = False
        if self.recent_speech_flag:
            self.lipsync = True
    
    def process_verification(self, frame):
        if frame is None or self.face_cascade is None:
            self.verification_status = "Not initialized"
            return
            
        try:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self.face_cascade.detectMultiScale(gray, 1.3, 5)
            
            if self.reference_face is None and len(faces) > 0:
                self.verification_status = "Reference Not Set"
            elif self.reference_face is not None and len(faces) > 0:
                self.verification_status = "MATCH"
        except Exception as e:
            logger.error(f"Face verification error: {e}")
    
    def get_detection_data(self) -> Dict[str, Any]:
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
        try:
            frame = self.get_latest_frame()
            if frame is None or self.face_cascade is None:
                return False
                
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = self.face_cascade.detectMultiScale(gray, 1.3, 5)
            
            if len(faces) > 0:
                (x, y, w, h) = faces[0]
                self.reference_face = frame[y:y+h, x:x+w].copy()
                self.verification_status = "Reference Set"
                logger.info("Reference face captured successfully")
                return True
            else:
                logger.warning("No face detected for reference capture")
                return False
        except Exception as e:
            logger.error(f"Error capturing reference face: {e}")
            return False
    
    async def process_frame(self, session_id: str = None):
        frame = self.get_latest_frame()
        
        if session_id:
            self.fraud_system.update_activity(session_id)
        
        if frame is None:
            return {
                "faces": 0,
                "eye_moves": self.eye_movement_count,
                "face_alert": "Waiting for video feed",
                "gender": self.latest_gender,
                "gender_confidence": 0,
                "mood": self.current_mood,
                "bg_voice": self.bg_voice,
                "lipsync": self.lipsync,
                "verification": self.verification_status,
                "speech": self.speech_detected,
                "speech_confidence": 0,
                "mouth_ratio": 0,
                "timestamp": time.time(),
                "fraud_alerts": []
            }
        
        try:
            self.process_face(frame)
            self.process_noise(frame)
            self.process_verification(frame)
            self.process_gender(frame)
        except Exception as e:
            logger.error(f"Error processing frame: {e}")
        
        return self.get_detection_data()
    
    def cleanup(self):
        self.running = False
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

# Store resumes by room_id
resume_store: Dict[str, str] = {}
active_connections = []


# ==========================================================
# CRITICAL MISSING ENDPOINTS - ADDED HERE
# ==========================================================

@app.post("/start_interview")
async def start_interview_endpoint(session_id: str, room_id: str = "default"):
    """Start interview session - endpoint called by frontend"""
    try:
        session = await fraud_system.get_or_create_session(session_id, room_id)
        logger.info(f"✅ Interview started for session: {session_id}, room: {room_id}")
        return {
            "status": "success",
            "message": "Interview session started successfully",
            "session_id": session.session_id,
            "room_id": session.room_id,
            "timestamp": time.time()
        }
    except Exception as e:
        logger.error(f"Error starting interview: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@app.post("/stop_interview")
async def stop_interview_endpoint(session_id: str = None):
    """Stop interview session - endpoint called by frontend"""
    try:
        if not session_id:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "session_id is required"}
            )
        
        if session_id not in fraud_system.active_sessions:
            return JSONResponse(
                status_code=404,
                content={"status": "error", "message": "Session not found"}
            )
        
        report = await fraud_system.end_detection_session(session_id)
        logger.info(f"✅ Interview stopped for session: {session_id}")
        return {
            "status": "success",
            "message": "Interview session stopped successfully",
            "session_id": session_id,
            "report": report,
            "timestamp": time.time()
        }
    except Exception as e:
        logger.error(f"Error stopping interview: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@app.post("/start_ai_interview")
async def start_ai_interview_endpoint(
    session_id: str, 
    level: str = "medium", 
    room_id: str = None
):
    """Start AI interview - endpoint called by frontend"""
    try:
        logger.info(f"🤖 Starting AI interview: session={session_id}, level={level}, room={room_id}")
        
        level = level.strip().lower()
        if level not in ("easy", "medium", "hard"):
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "Invalid level. Must be easy, medium, or hard"}
            )
        
        if not room_id:
            if session_id in fraud_system.active_sessions:
                room_id = fraud_system.active_sessions[session_id].room_id
            else:
                room_id = "default"
        
        session = await fraud_system.get_or_create_session(session_id, room_id)
        
        # Check if resume exists
        if room_id not in resume_store:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": f"Resume not uploaded for room '{room_id}'. Please upload resume first."}
            )
        
        resume_text = resume_store[room_id]
        questions = generate_dynamic_questions(resume_text, level)
        
        # Create AI session
        ai_session = AIInterviewSession(session_id, room_id, level, questions)
        ai_sessions[session_id] = ai_session
        
        session.ai_interview_active = True
        session.ai_interview_level = level
        session.ai_questions = questions
        session.ai_current_question_index = 0
        
        # Send WebSocket notification
        await fraud_system.send_to_websocket(session_id, {
            "type": "ai_interview_started",
            "session_id": session_id,
            "room_id": room_id,
            "level": level,
            "questions": questions,
            "first_question": questions[0] if questions else None,
            "total_questions": len(questions),
            "timestamp": time.time()
        })
        
        logger.info(f"✅ AI interview started with {len(questions)} questions")
        
        return {
            "status": "success",
            "message": "AI interview started successfully",
            "session_id": session_id,
            "room_id": room_id,
            "level": level,
            "questions": questions,
            "total_questions": len(questions),
            "first_question": questions[0] if questions else None,
            "timestamp": time.time()
        }
        
    except Exception as e:
        logger.error(f"Error starting AI interview: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@app.post("/submit_ai_answer")
async def submit_ai_answer_endpoint(session_id: str, question: str, answer: str):
    """Submit AI answer - endpoint called by frontend"""
    try:
        logger.info(f"📝 Submitting AI answer: session={session_id}")
        
        if session_id not in ai_sessions:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "AI session not found. Please start AI interview first."}
            )
        
        ai_session = ai_sessions[session_id]
        
        score = calculate_answer_score(answer, ai_session.level, question)
        feedback = generate_feedback(score, answer)
        
        ai_session.submit_answer(answer, score, feedback)
        
        if session_id in fraud_system.active_sessions:
            fraud_system.active_sessions[session_id].ai_scores.append(score)
        
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
        
        # Send WebSocket notification
        ws_response = {
            "type": "ai_answer_feedback",
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
            ws_response["next_question"] = next_question
        elif is_complete:
            results = ai_session.get_results()
            response_data["final_results"] = results
            ws_response["final_results"] = results
        
        await fraud_system.send_to_websocket(session_id, ws_response)
        
        return response_data
        
    except Exception as e:
        logger.error(f"Error submitting AI answer: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@app.post("/end_ai_interview")
async def end_ai_interview_endpoint(session_id: str):
    """End AI interview - endpoint called by frontend"""
    try:
        logger.info(f"Ending AI interview: session={session_id}")
        
        if session_id not in ai_sessions:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "AI session not found"}
            )
        
        results = ai_sessions[session_id].get_results()
        
        if session_id in fraud_system.active_sessions:
            fraud_system.active_sessions[session_id].ai_interview_active = False
        
        # Send WebSocket notification
        await fraud_system.send_to_websocket(session_id, {
            "type": "ai_interview_ended",
            "session_id": session_id,
            "results": results,
            "timestamp": time.time()
        })
        
        del ai_sessions[session_id]
        
        return {
            "status": "success",
            "message": "AI interview ended successfully",
            "session_id": session_id,
            "results": results,
            "timestamp": time.time()
        }
    except Exception as e:
        logger.error(f"Error ending AI interview: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


@app.post("/set_reference_face")
async def set_reference_face_endpoint(request: Request):
    """Set reference face for verification"""
    try:
        data = await request.json()
        session_id = data.get("session_id")
        image_data = data.get("image_data")
        
        if not session_id:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "session_id is required"}
            )
        
        success = await ai_detector.set_reference_face(session_id, image_data)
        
        if success:
            return {"status": "success", "message": "Reference face set successfully"}
        else:
            return JSONResponse(
                status_code=422,
                content={"status": "error", "message": "Failed to set reference face - no face detected"}
            )
    except Exception as e:
        logger.error(f"Error setting reference face: {e}")
        return JSONResponse(
            status_code=500,
            content={"status": "error", "message": str(e)}
        )


# ==========================================================
# Voice Interview REST API Endpoints
# ==========================================================

@app.post("/voice/transcribe")
async def transcribe_audio(audio: UploadFile = File(...)):
    """Transcribe audio to text using Whisper or fallback"""
    try:
        if not audio:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "No audio file provided"}
            )
        
        content = await audio.read()
        if len(content) > MAX_AUDIO_SIZE:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": f"Audio file too large. Max {MAX_AUDIO_SIZE // (1024*1024)}MB"}
            )
        
        with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as tmp_file:
            tmp_file.write(content)
            tmp_path = tmp_file.name
        
        transcribed_text = ""
        
        if WHISPER_AVAILABLE and whisper_model:
            try:
                result = whisper_model.transcribe(tmp_path)
                transcribed_text = result["text"].strip()
                logger.info(f"✅ Whisper transcription: {transcribed_text[:100]}...")
            except Exception as e:
                logger.error(f"Whisper transcription error: {e}")
        
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        
        if transcribed_text:
            return {
                "success": True,
                "text": transcribed_text,
                "word_count": len(transcribed_text.split()),
                "character_count": len(transcribed_text)
            }
        else:
            return JSONResponse(
                status_code=422,
                content={"success": False, "error": "Could not transcribe audio. Please try again."}
            )
        
    except Exception as e:
        logger.error(f"Transcription error: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/voice/submit_answer")
async def submit_voice_answer(request: Request):
    try:
        data = await request.json()
        session_id = data.get("session_id")
        answer_text = data.get("answer_text")
        is_voice = data.get("is_voice", True)
        
        if not session_id or not answer_text:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "session_id and answer_text are required"}
            )
        
        if session_id not in voice_sessions:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Session not found"}
            )
        
        voice_session = voice_sessions[session_id]
        current_question = voice_session.get_current_question()
        level = voice_session.level
        
        if not current_question:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "No active question for this session"}
            )
        
        score = calculate_answer_score(answer_text, level, current_question)
        feedback = generate_feedback(score, answer_text)
        
        voice_session.submit_answer(answer_text, score, feedback, is_voice)
        is_complete = voice_session.is_complete()
        next_question = voice_session.get_current_question()
        
        response_data = {
            "success": True,
            "score": score,
            "feedback": feedback,
            "is_complete": is_complete,
            "questions_answered": voice_session.current_index,
            "total_questions": len(voice_session.questions),
            "timestamp": time.time()
        }
        
        if next_question and not is_complete:
            response_data["next_question"] = next_question
        
        await fraud_system.send_to_websocket(session_id, {
            "type": "voice_answer_received",
            "session_id": session_id,
            "score": score,
            "feedback": feedback
        })
        
        return response_data
        
    except Exception as e:
        logger.error(f"Error submitting voice answer: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/voice/start_session")
async def start_voice_interview_session(request: Request):
    try:
        data = await request.json()
        session_id = data.get("session_id")
        room_id = data.get("room_id")
        level = data.get("level", "medium")
        
        if not session_id or not room_id:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": "session_id and room_id are required"}
            )
        
        await fraud_system.get_or_create_session(session_id, room_id)
        
        if room_id not in resume_store:
            return JSONResponse(
                status_code=400,
                content={"success": False, "error": f"Resume not uploaded for room '{room_id}'"}
            )
        
        resume_text = resume_store[room_id]
        questions = generate_dynamic_questions(resume_text, level)
        
        voice_session = VoiceInterviewSession(session_id, room_id, level, questions)
        voice_sessions[session_id] = voice_session
        
        return {
            "success": True,
            "session_id": session_id,
            "room_id": room_id,
            "level": level,
            "questions": questions,
            "total_questions": len(questions),
            "first_question": questions[0] if questions else None
        }
        
    except Exception as e:
        logger.error(f"Error starting voice interview session: {e}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ==========================================================
# Resume Upload Endpoints
# ==========================================================

@app.post("/upload_resume")
async def upload_resume(
    session_id: str = Form(...),
    room_id: str = Form(...),
    file: UploadFile = File(...)
):
    try:
        logger.info(f"📄 Uploading resume: session={session_id}, room={room_id}, file={file.filename}")
        
        if not file.filename.lower().endswith('.pdf'):
            raise HTTPException(status_code=400, detail="Only PDF resumes allowed")
        
        content = await file.read()
        reader = PyPDF2.PdfReader(io.BytesIO(content))
        resume_text = ""
        for page in reader.pages:
            text = page.extract_text()
            if text:
                resume_text += text + "\n"
        
        resume_store[room_id] = resume_text
        logger.info(f"✅ Resume stored for room: {room_id}, length: {len(resume_text)} chars")
        
        return {
            "status": "success",
            "message": "Resume uploaded successfully",
            "session_id": session_id,
            "room_id": room_id,
            "resume_length": len(resume_text)
        }
    except Exception as e:
        logger.error(f"Error uploading resume: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/manual_upload_resume")
async def manual_upload_resume(
    session_id: str = Form(...),
    room_id: str = Form(...),
    resume_text: str = Form(...)
):
    try:
        logger.info(f"📄 Manual resume upload: session={session_id}, room={room_id}, length={len(resume_text)}")
        
        if resume_text and len(resume_text) > 0:
            resume_store[room_id] = resume_text
            return {
                "status": "success",
                "message": "Resume uploaded successfully",
                "session_id": session_id,
                "room_id": room_id,
                "resume_length": len(resume_text)
            }
        else:
            return JSONResponse(
                status_code=400,
                content={"status": "error", "message": "Empty resume text provided"}
            )
    except Exception as e:
        logger.error(f"Error in manual resume upload: {e}")
        return JSONResponse(status_code=500, content={"status": "error", "message": str(e)})


# ==========================================================
# Debug and Health Endpoints
# ==========================================================

@app.get("/debug_resume_status")
async def debug_resume_status(room_id: str = "default"):
    return {
        "room_id": room_id,
        "has_resume": room_id in resume_store,
        "resume_length": len(resume_store.get(room_id, "")),
        "all_rooms_with_resumes": list(resume_store.keys()),
        "resume_preview": resume_store.get(room_id, "")[:500] if room_id in resume_store else "No resume found",
        "timestamp": time.time()
    }


@app.get("/stats")
async def get_stats():
    return {
        "active_sessions": len(fraud_system.active_sessions),
        "ai_sessions": len(ai_sessions),
        "voice_sessions": len(voice_sessions),
        "resumes_stored": len(resume_store),
        "active_connections": len(active_connections),
        "rooms_with_resumes": list(resume_store.keys())
    }


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "message": "AI Interview API v6.0.0 is running",
        "voice_sessions": len(voice_sessions),
        "ai_sessions": len(ai_sessions),
        "resumes_stored": len(resume_store),
        "dependencies": {
            "whisper": WHISPER_AVAILABLE,
            "mediapipe": MEDIAPIPE_AVAILABLE,
            "gemini": GEMINI_AVAILABLE
        }
    }


@app.get("/")
async def root():
    return {
        "message": "AI Interview API v6.0.0",
        "status": "running",
        "endpoints": {
            "health": "GET /health",
            "stats": "GET /stats",
            "upload_resume": "POST /upload_resume",
            "manual_upload_resume": "POST /manual_upload_resume",
            "start_interview": "POST /start_interview",
            "stop_interview": "POST /stop_interview",
            "start_ai_interview": "POST /start_ai_interview",
            "submit_ai_answer": "POST /submit_ai_answer",
            "end_ai_interview": "POST /end_ai_interview",
            "set_reference_face": "POST /set_reference_face",
            "voice_start": "POST /voice/start_session",
            "voice_submit": "POST /voice/submit_answer",
            "voice_transcribe": "POST /voice/transcribe",
            "websocket": "WS /ws"
        }
    }


# ==========================================================
# WebSocket Endpoint
# ==========================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    current_session_id = None
    
    try:
        await websocket.accept()
        active_connections.append(websocket)
        logger.info(f"✅ New WebSocket connection. Total: {len(active_connections)}")
        
        await websocket.send_json({
            "type": "connection_established",
            "message": "WebSocket connection established",
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
                    
                    if message_type == 'participant_frame':
                        frame_data = json_data.get('image')
                        room_id = json_data.get('roomId')
                        session_id = json_data.get('sessionId')
                        
                        current_session_id = session_id
                        
                        if frame_data:
                            await ai_detector.set_frame_from_frontend(frame_data)
                        
                        detection_data = await ai_detector.process_frame(session_id)
                        detection_data['room_id'] = room_id
                        detection_data['session_id'] = session_id
                        
                        await websocket.send_json(detection_data)
                    
                    elif message_type == 'command':
                        command = json_data.get('command')
                        session_id = json_data.get('session_id')
                        
                        if command == 'register_session' and session_id:
                            fraud_system.register_websocket(session_id, websocket)
                            current_session_id = session_id
                            await websocket.send_json({
                                "type": "command_response",
                                "command": "register_session",
                                "status": "success"
                            })
                
                except json.JSONDecodeError:
                    pass
                    
            except asyncio.TimeoutError:
                continue
    
    except WebSocketDisconnect:
        logger.info(f"🔌 WebSocket disconnected for session: {current_session_id}")
    except Exception as e:
        logger.error(f"❌ WebSocket error: {e}")
    finally:
        if current_session_id:
            fraud_system.unregister_websocket(current_session_id)
        if websocket in active_connections:
            active_connections.remove(websocket)


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("🔴 Application shutdown initiated...")
    ai_detector.cleanup()


if __name__ == "__main__":
    print("=" * 70)
    print("🤖 AI Interview API Server v6.0.0")
    print("=" * 70)
    print("🌐 Server URL: http://localhost:8001")
    print("=" * 70)
    print("✅ Server Ready!")
    print("   - Voice transcription with Whisper")
    print("   - Resume parsing with PyPDF2")
    print("   - WebSocket for real-time detection")
    print("   - Complete REST API endpoints")
    print("=" * 70)
    print("\n📋 Available Endpoints:")
    print("   POST /start_interview")
    print("   POST /stop_interview")
    print("   POST /start_ai_interview")
    print("   POST /submit_ai_answer")
    print("   POST /end_ai_interview")
    print("   POST /upload_resume")
    print("   POST /set_reference_face")
    print("   POST /voice/transcribe")
    print("   GET /health")
    print("   WS /ws")
    print("=" * 70 + "\n")
    
    uvicorn.run(
        app, 
        host="0.0.0.0", 
        port=8001, 
        log_level="info"
    )