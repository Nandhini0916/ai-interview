# ai_interview_model.py
# ==========================================================
# AI Interview Model (Easy / Medium / Hard)
# ==========================================================

import os
import re
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
                    model="gemini-2.0-flash-exp",
                    contents=prompt
                )
                return response.text.strip()
            except Exception as e:
                return f"Error: {str(e)}"
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
        "easy": "Ask basic conceptual questions based on the resume.",
        "medium": "Ask practical, scenario-based questions based on projects in the resume.",
        "hard": "Ask advanced technical questions about specific technologies in the resume."
    }

    @staticmethod
    def generate(resume_text: str, level: str) -> List[str]:
        """Generate interview questions based on resume"""
        
        # If we have valid resume and Gemini is available
        if GEMINI_AVAILABLE and resume_text and len(resume_text.strip()) > 100:
            prompt = f"""
You are a technical interviewer. Generate 5 interview questions based ONLY on this resume.

Resume:
{resume_text[:2000]}

Difficulty: {level.upper()}
{QuestionGenerator.LEVEL_RULES[level]}

Output exactly 5 questions as a numbered list (1. 2. 3. 4. 5.).
Each question must reference something specific from the resume.
"""
            text = gemini(prompt)
            
            # Parse questions
            questions = []
            for line in text.split('\n'):
                line = line.strip()
                if line and re.match(r'^\d+\.', line):
                    question = re.sub(r'^\d+\.\s*', '', line)
                    if len(question) > 10:
                        questions.append(question)
            
            if len(questions) >= 3:
                return questions[:5]
        
        # Fallback questions based on resume content
        if resume_text and len(resume_text.strip()) > 50:
            return QuestionGenerator._extract_questions_from_resume(resume_text, level)
        
        # Default questions if no resume
        return [
            "Tell me about yourself and your background.",
            "What programming languages are you most proficient in?",
            "Describe a challenging project you worked on.",
            "What are your career goals?",
            "Why are you interested in this position?"
        ]
    
    @staticmethod
    def _extract_questions_from_resume(resume_text: str, level: str) -> List[str]:
        """Extract questions from resume content"""
        questions = []
        resume_lower = resume_text.lower()
        
        # Find skills
        skills = ['python', 'java', 'javascript', 'react', 'angular', 'node', 'django', 
                  'flask', 'sql', 'mongodb', 'aws', 'docker', 'kubernetes', 'tensorflow',
                  'pytorch', 'html', 'css', 'typescript', 'c++', 'c#', 'php', 'ruby', 'go']
        
        found_skills = [s for s in skills if s in resume_lower]
        
        if found_skills:
            questions.append(f"Your resume lists {found_skills[0].upper()}. Can you describe your experience with this technology?")
        
        # Find projects (look for project indicators)
        if 'project' in resume_lower:
            questions.append("Tell me about the most challenging project mentioned in your resume.")
        
        # Experience questions
        if 'experience' in resume_lower or 'work' in resume_lower:
            questions.append("What was your most significant achievement in your previous role?")
        
        # Add more questions based on level
        if level == "easy":
            questions.extend([
                "What technologies are you most comfortable with?",
                "Describe a typical day in your current/past role.",
                "How do you stay updated with new technologies?"
            ])
        elif level == "medium":
            questions.extend([
                "Describe a technical problem you solved and your approach.",
                "How do you handle tight deadlines and pressure?",
                "Explain a time you had to debug a complex issue."
            ])
        else:
            questions.extend([
                "Describe a system you designed that handled high traffic.",
                "How do you approach performance optimization?",
                "Explain a technical decision you made that had significant impact."
            ])
        
        return questions[:5]


# ==========================================================
# Answer Evaluator
# ==========================================================

class AnswerEvaluator:
    @staticmethod
    def evaluate(question: str, answer: str, level: str) -> Tuple[int, str]:
        """Evaluate answer and return score (0-10) and feedback"""
        
        if not answer or len(answer.strip()) < 10:
            return 2, "Answer too short. Please provide more detail."
        
        word_count = len(answer.split())
        
        # Use Gemini if available
        if GEMINI_AVAILABLE:
            prompt = f"""
Evaluate this interview answer.

Question: {question}
Answer: {answer}
Difficulty: {level}

Give score out of 10 and brief feedback.
Output format:
Score: X/10
Feedback: [one sentence]
"""
            text = gemini(prompt)
            
            try:
                score_line = [l for l in text.split('\n') if 'score' in l.lower()]
                if score_line:
                    score_text = re.search(r'(\d+)', score_line[0])
                    if score_text:
                        score = min(10, max(0, int(score_text.group(1))))
                    else:
                        score = 5
                else:
                    score = 5
                
                feedback_line = [l for l in text.split('\n') if 'feedback' in l.lower()]
                feedback = feedback_line[0].split(':', 1)[-1].strip() if feedback_line else "Evaluation complete."
                
                return score, feedback
            except:
                pass
        
        # Simple heuristic scoring
        if level == "easy":
            score = min(10, word_count // 10)
        elif level == "medium":
            score = min(10, word_count // 15)
        else:
            score = min(10, word_count // 20)
        
        # Bonus for technical terms
        tech_terms = ['because', 'example', 'implement', 'design', 'solution', 'approach', 
                      'optimize', 'performance', 'database', 'algorithm', 'architecture']
        bonus = sum(1 for term in tech_terms if term in answer.lower())
        score = min(10, score + bonus // 2)
        
        if score >= 8:
            feedback = f"Excellent answer! Score: {score}/10"
        elif score >= 6:
            feedback = f"Good answer. Score: {score}/10"
        elif score >= 4:
            feedback = f"Satisfactory answer. Score: {score}/10"
        else:
            feedback = f"Needs improvement. Please elaborate more. Score: {score}/10"
        
        return score, feedback


# ==========================================================
# Interview Session
# ==========================================================

class InterviewSession:
    def __init__(self, resume_text: str, level: str):
        self.level = level
        self.resume_text = resume_text
        self.questions = QuestionGenerator.generate(resume_text, level)
        self.current_index = 0
        self.scores = []
        self.history = []
        self.completed = False

    def get_next_question(self):
        if self.current_index < len(self.questions):
            q = self.questions[self.current_index]
            self.current_index += 1
            return q
        self.completed = True
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
        return {"score": score, "feedback": feedback, "completed": self.completed}
    
    def get_progress(self):
        return {
            "answered": len(self.scores),
            "total": len(self.questions),
            "remaining": len(self.questions) - len(self.scores),
            "completed": self.completed
        }


class AIInterviewEngine:
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
            total = sum(session.scores)
            max_score = len(session.scores) * 10
            percentage = (total / max_score) * 100 if max_score else 0
            
            if percentage >= 80:
                verdict = "Excellent"
            elif percentage >= 60:
                verdict = "Good"
            elif percentage >= 40:
                verdict = "Average"
            else:
                verdict = "Needs Improvement"
            
            result = {
                "total_score": total,
                "max_score": max_score,
                "percentage": round(percentage, 2),
                "verdict": verdict,
                "scores": session.scores
            }
        else:
            result = {"error": "No answers submitted"}
        
        del self.sessions[session_id]
        return result


class ResultEvaluator:
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
            "verdict": verdict,
            "individual_scores": scores
        }