# ai_interview_model.py
# ==========================================================
# AI Interview Model (Easy / Medium / Hard)
# Simplified version for integration
# ==========================================================

import os
from typing import List, Tuple

# Try to import Google Gemini, but don't crash if not available
try:
    from google import genai
    GEMINI_AVAILABLE = True
    
    API_KEY = os.getenv("GEMINI_API_KEY", "AIzaSyC0O0RTtcpnT8hwi78xQSVKXJCP3wmaqXg")
    
    if API_KEY.startswith("AIzaSy"):
        client = genai.Client(api_key=API_KEY)
        
        def gemini(prompt: str) -> str:
            """Helper function to call Gemini safely"""
            try:
                response = client.models.generate_content(
                    model="gemini-2.5-flash-exp",
                    contents=prompt
                )
                return response.text.strip()
            except Exception as e:
                return f"Error calling Gemini: {str(e)}"
    else:
        GEMINI_AVAILABLE = False
        def gemini(prompt: str) -> str:
            return "Gemini API key not configured"
            
except ImportError:
    GEMINI_AVAILABLE = False
    def gemini(prompt: str) -> str:
        return "Google Gemini not available"

# ==========================================================
# Question Generator
# ==========================================================

class QuestionGenerator:
    LEVEL_RULES = {
        "easy": "Ask basic conceptual and resume-based questions.",
        "medium": "Ask practical, scenario-based and implementation questions.",
        "hard": "Ask advanced system design, optimization, edge cases, and deep technical questions."
    }

    @staticmethod
    def generate(resume_text: str, level: str) -> List[str]:
        """Generate interview questions based on resume and difficulty level"""
        
        # If Gemini is available, use it
        if GEMINI_AVAILABLE:
            prompt = f"""
You are a technical interviewer.

Difficulty Level: {level.upper()}
Guideline: {QuestionGenerator.LEVEL_RULES[level]}

From the resume below:
- Generate exactly 5 interview questions
- Mix skills, projects, and experience
- Do NOT provide answers

Resume:
{resume_text[:2000]}  # Limit resume text

Output ONLY as a numbered list.
"""
            text = gemini(prompt)
            
            # Parse the response into a list of questions
            questions = []
            for line in text.split('\n'):
                line = line.strip()
                if line and (line[0].isdigit() or line.startswith('•') or line.startswith('-')):
                    # Remove numbering/bullets
                    if '. ' in line:
                        question = line.split('. ', 1)[-1]
                    elif ') ' in line:
                        question = line.split(') ', 1)[-1]
                    else:
                        question = line.lstrip('•- ')
                    if question and len(question) > 10:  # Valid question
                        questions.append(question)
            
            if questions:
                return questions[:5]  # Return up to 5 questions
        
        # Fallback questions if Gemini fails or not available
        fallback_questions = {
            "easy": [
                "Tell me about yourself and your background.",
                "What programming languages are you most comfortable with?",
                "Describe a project you worked on recently.",
                "What do you know about our company?",
                "Why are you interested in this position?"
            ],
            "medium": [
                "Explain the difference between SQL and NoSQL databases.",
                "Describe a challenging bug you fixed and how you approached it.",
                "How would you design a REST API for a todo list application?",
                "What testing strategies do you use in your projects?",
                "How do you handle conflicts in a team environment?"
            ],
            "hard": [
                "Design a system to handle millions of concurrent users.",
                "Explain how you would optimize a slow-running database query.",
                "Describe the CAP theorem and its implications for distributed systems.",
                "How would you implement authentication in a microservices architecture?",
                "Explain the trade-offs between different database indexing strategies."
            ]
        }
        
        return fallback_questions.get(level, fallback_questions["medium"])

# ==========================================================
# Answer Evaluator
# ==========================================================

class AnswerEvaluator:
    STRICTNESS = {
        "easy": "Be lenient and focus on understanding.",
        "medium": "Expect clarity, correctness, and examples.",
        "hard": "Be strict. Expect depth, trade-offs, and technical accuracy."
    }

    @staticmethod
    def evaluate(question: str, answer: str, level: str) -> Tuple[int, str]:
        """Evaluate an answer and return score (0-10) and feedback"""
        
        # If Gemini is available, use it for evaluation
        if GEMINI_AVAILABLE:
            prompt = f"""
You are an interview evaluator.

Difficulty Level: {level.upper()}
Evaluation Style: {AnswerEvaluator.STRICTNESS[level]}

Question:
{question}

Candidate Answer:
{answer}

Evaluate and provide:
- Score out of 10 (be strict for hard, lenient for easy)
- One-line feedback

Format EXACTLY:
Score: X/10
Feedback: ...
"""
            text = gemini(prompt)
            
            # Parse the response
            score = 5  # Default score
            feedback = "Evaluation not available"
            
            try:
                lines = text.strip().split('\n')
                for line in lines:
                    if line.lower().startswith('score:'):
                        score_part = line.split(':')[1].strip()
                        if '/' in score_part:
                            score = int(score_part.split('/')[0].strip())
                        else:
                            score = int(score_part)
                    elif line.lower().startswith('feedback:'):
                        feedback = line.split(':', 1)[1].strip()
            except:
                # If parsing fails, use defaults
                pass
            
            return min(max(score, 0), 10), feedback
        
        # Fallback evaluation based on answer length and level
        word_count = len(answer.split())
        
        # Base score on word count (more words = better for easy/medium)
        if level == "easy":
            score = min(10, word_count // 5)
        elif level == "medium":
            score = min(10, word_count // 8)
        else:  # hard
            score = min(10, word_count // 10)
        
        # Adjust score based on presence of technical keywords
        tech_keywords = ['because', 'example', 'implement', 'design', 'optimize', 'algorithm', 'architecture']
        tech_count = sum(1 for keyword in tech_keywords if keyword.lower() in answer.lower())
        score = min(10, score + tech_count)
        
        # Generate feedback based on score
        if score >= 8:
            feedback = f"Excellent answer! Score: {score}/10"
        elif score >= 6:
            feedback = f"Good answer. Score: {score}/10"
        elif score >= 4:
            feedback = f"Average answer. Score: {score}/10"
        else:
            feedback = f"Needs improvement. Score: {score}/10"
        
        return score, feedback

# ==========================================================
# Simplified Interview Session (for backward compatibility)
# ==========================================================

class InterviewSession:
    """Simple session class for backward compatibility"""
    def __init__(self, resume_text: str, level: str):
        self.level = level
        self.resume_text = resume_text
        self.questions = QuestionGenerator.generate(resume_text, level)
        self.current_index = 0
        self.scores = []
        self.history = []

    def get_next_question(self):
        if self.current_index < len(self.questions):
            q = self.questions[self.current_index]
            self.current_index += 1
            return q
        return None

    def submit_answer(self, question: str, answer: str):
        score, feedback = AnswerEvaluator.evaluate(question, answer, self.level)
        self.scores.append(score)
        self.history.append({
            "question": question,
            "answer": answer,
            "score": score,
            "feedback": feedback
        })
        return {"score": score, "feedback": feedback}

# ==========================================================
# AI Interview Engine (optional - for backward compatibility)
# ==========================================================

class AIInterviewEngine:
    """Optional engine class for backward compatibility"""
    def __init__(self):
        self.sessions = {}

    def start_interview(self, session_id: str, resume_text: str, level: str):
        session = InterviewSession(resume_text, level)
        self.sessions[session_id] = session
        return session.questions

    def answer_question(self, session_id: str, question: str, answer: str):
        session = self.sessions.get(session_id)
        if not session:
            return {"error": "Session not found"}
        return session.submit_answer(question, answer)

    def end_interview(self, session_id: str):
        session = self.sessions.get(session_id)
        if not session:
            return {"error": "Session not found"}
        
        if session.scores:
            total_score = sum(session.scores)
            max_score = len(session.scores) * 10
            percentage = (total_score / max_score) * 100 if max_score else 0
            
            if percentage >= 80:
                verdict = "Excellent"
            elif percentage >= 60:
                verdict = "Good"
            elif percentage >= 40:
                verdict = "Average"
            else:
                verdict = "Needs Improvement"
            
            result = {
                "total_score": total_score,
                "max_score": max_score,
                "percentage": round(percentage, 2),
                "verdict": verdict
            }
        else:
            result = {"error": "No answers submitted"}
        
        del self.sessions[session_id]
        return result

# ==========================================================
# Result Evaluator (optional - for backward compatibility)
# ==========================================================

class ResultEvaluator:
    """Optional result evaluator for backward compatibility"""
    @staticmethod
    def calculate(scores: list) -> dict:
        if not scores:
            return {"error": "No scores provided"}
        
        total = sum(scores)
        max_score = len(scores) * 10
        percentage = (total / max_score) * 100 if max_score else 0

        if percentage >= 80:
            verdict = "Excellent"
        elif percentage >= 60:
            verdict = "Good"
        elif percentage >= 40:
            verdict = "Average"
        else:
            verdict = "Needs Improvement"

        return {
            "total_score": total,
            "max_score": max_score,
            "percentage": round(percentage, 2),
            "verdict": verdict
        }
