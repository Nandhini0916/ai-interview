import React, { useState, useEffect } from "react";
import "./ParticipantAIInterviewQA.css";

function ParticipantAIInterviewQA({
  question,
  answer,
  setAnswer,
  disabled,
  onSubmit,
  aiInterviewerStatus = "idle",
  isResponding = false,
  currentQuestionNumber = 0,
  totalQuestions = 10,
  resumeUploaded = false
}) {
  const [isTyping, setIsTyping] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  
  // Calculate word and character counts
  useEffect(() => {
    const trimmedAnswer = answer.trim();
    setCharCount(trimmedAnswer.length);
    setWordCount(trimmedAnswer ? trimmedAnswer.split(/\s+/).filter(word => word.length > 0).length : 0);
  }, [answer]);
  
  // Handle typing animation
  useEffect(() => {
    if (answer && answer.length > 0) {
      setIsTyping(true);
      const timeout = setTimeout(() => setIsTyping(false), 300);
      return () => clearTimeout(timeout);
    }
  }, [answer]);
  
  // Handle Enter key to submit (with Ctrl/Cmd)
  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !disabled && answer.trim()) {
      e.preventDefault();
      onSubmit();
    }
  };
  
  // Get status indicator
  const getStatusInfo = () => {
    switch(aiInterviewerStatus) {
      case 'speaking': 
        return { color: '#9b59b6', icon: '📝', text: 'AI is preparing question...' };
      case 'listening': 
        return { color: '#27ae60', icon: '👂', text: 'Waiting for your response...' };
      case 'analyzing': 
        return { color: '#f39c12', icon: '🔍', text: 'Analyzing your answer...' };
      case 'error': 
        return { color: '#e74c3c', icon: '⚠️', text: 'AI encountered an error' };
      case 'generating': 
        return { color: '#3498db', icon: '⚙️', text: 'Generating next question...' };
      case 'resume_analyzing': 
        return { color: '#8e44ad', icon: '📄', text: 'Analyzing resume for questions...' };
      default: 
        return { color: '#7f8c8d', icon: '🤖', text: 'AI Interviewer Ready' };
    }
  };

  const statusInfo = getStatusInfo();

  return (
    <div className="participant-ai-qa-container">
      {/* AI Interviewer Header */}
      <div className="participant-ai-header">
        <div className="participant-ai-title">
          <span className="participant-ai-icon">🤖</span>
          <h3>AI Interview Session</h3>
          <span className="participant-question-counter">
            Question {currentQuestionNumber}/{totalQuestions}
          </span>
        </div>
        <div 
          className="participant-ai-status-indicator" 
          style={{ backgroundColor: statusInfo.color }}
        >
          <span className="participant-ai-status-icon">{statusInfo.icon}</span>
          <span className="participant-ai-status-text">{statusInfo.text}</span>
        </div>
      </div>
      
      {/* Resume Status */}
      {resumeUploaded ? (
        <div className="participant-resume-status active">
          <span className="participant-resume-icon">✅</span>
          <span className="participant-resume-text">
            Resume uploaded - AI will ask personalized questions
          </span>
        </div>
      ) : (
        <div className="participant-resume-status inactive">
          <span className="participant-resume-icon">⚠️</span>
          <span className="participant-resume-text">
            No resume uploaded - AI will ask general questions
          </span>
        </div>
      )}
      
      {/* AI Question Section */}
      <div className="participant-ai-question-section">
        <div className="participant-section-label">
          <span className="participant-label-icon">❓</span>
          AI Question
        </div>
        <div className="participant-ai-question-card">
          <div className="participant-ai-question-text">
            {question || "AI is preparing your first question based on your resume..."}
          </div>
          {question && (
            <div className="participant-question-stats">
              <span className="participant-stat-item">
                <span className="participant-stat-icon">📏</span>
                {question.split(' ').length} words
              </span>
              <span className="participant-stat-item">
                <span className="participant-stat-icon">⏱️</span>
                30-60 seconds recommended response time
              </span>
              <span className="participant-stat-item">
                <span className="participant-stat-icon">🎯</span>
                Based on your {resumeUploaded ? 'resume' : 'profile'}
              </span>
            </div>
          )}
        </div>
        
        {/* Progress Indicator */}
        <div className="participant-response-progress">
          <div className="participant-progress-label">
            <span>Response Progress</span>
            <span className="participant-progress-percent">
              {Math.min(Math.round((charCount / 500) * 100), 100)}%
            </span>
          </div>
          <div className="participant-progress-bar">
            <div 
              className="participant-progress-fill"
              style={{ 
                width: `${Math.min((charCount / 500) * 100, 100)}%`,
                backgroundColor: statusInfo.color
              }}
            ></div>
          </div>
          <div className="participant-progress-stats">
            <span className={`participant-progress-stat ${wordCount < 50 ? 'warning' : ''}`}>
              <span className="participant-stat-icon">📝</span>
              {wordCount} {wordCount === 1 ? 'word' : 'words'}
              {wordCount < 50 && ' (Try to write more)'}
            </span>
            <span className={`participant-progress-stat ${charCount > 500 ? 'warning' : ''}`}>
              <span className="participant-stat-icon">✍️</span>
              {charCount}/500 characters
            </span>
          </div>
        </div>
      </div>
      
      {/* Your Response Section */}
      <div className="participant-response-section">
        <div className="participant-section-label">
          <span className="participant-label-icon">💬</span>
          Your Response
        </div>
        <div className="participant-response-container">
          <textarea
            className="participant-response-textarea"
            placeholder={
              disabled ? (
                aiInterviewerStatus === 'speaking' || aiInterviewerStatus === 'generating' ? 
                "AI is preparing the next question..." : 
                "Type your answer here..."
              ) : "Type your answer here. Press Ctrl+Enter to submit."
            }
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled || aiInterviewerStatus !== 'listening'}
            rows="6"
            maxLength="2000"
          />
          
          {/* Character Counter & Controls */}
          <div className="participant-response-controls">
            <div className="participant-char-counter">
              <span className={`participant-counter ${charCount > 500 ? 'warning' : ''}`}>
                {charCount}/500 characters
              </span>
              {isTyping && <span className="participant-typing-indicator">✍️ Typing...</span>}
            </div>
            
            <div className="participant-submit-section">
              <button
                className="participant-submit-button"
                disabled={
                  disabled || 
                  aiInterviewerStatus !== 'listening' || 
                  answer.trim() === "" ||
                  isResponding
                }
                onClick={onSubmit}
              >
                {isResponding ? (
                  <>
                    <span className="participant-submit-spinner"></span>
                    Sending...
                  </>
                ) : (
                  <>
                    <span className="participant-submit-icon">📤</span>
                    Submit Answer
                  </>
                )}
              </button>
              <div className="participant-shortcut-hint">
                Press <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to submit
              </div>
            </div>
          </div>
          
          {/* Response Tips */}
          <div className="participant-response-tips">
            <div className="participant-tips-title">
              <span className="participant-tips-icon">💡</span>
              Tips for a good answer:
            </div>
            <ul className="participant-tips-list">
              <li>Be specific and provide examples</li>
              <li>Aim for 50-100 words per answer</li>
              <li>Structure your answer clearly</li>
              <li>Relate answers to your resume experience</li>
            </ul>
          </div>
        </div>
      </div>
      
      {/* Interview Progress Bar */}
      <div className="participant-interview-progress">
        <div className="participant-interview-progress-label">
          Interview Progress
        </div>
        <div className="participant-interview-progress-bar">
          <div 
            className="participant-interview-progress-fill"
            style={{ 
              width: `${(currentQuestionNumber / totalQuestions) * 100}%`,
              backgroundColor: statusInfo.color
            }}
          ></div>
        </div>
        <div className="participant-interview-stats">
          <span className="participant-interview-stat">
            <span className="participant-stat-icon">✅</span>
            {currentQuestionNumber} questions answered
          </span>
          <span className="participant-interview-stat">
            <span className="participant-stat-icon">⏱️</span>
            Estimated: {Math.round((totalQuestions - currentQuestionNumber) * 2)} min remaining
          </span>
        </div>
      </div>
    </div>
  );
}

export default ParticipantAIInterviewQA;