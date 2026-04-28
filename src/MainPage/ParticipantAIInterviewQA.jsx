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
  const [submitAttempts, setSubmitAttempts] = useState(0);
  const [lastSubmitTime, setLastSubmitTime] = useState(0);
  const [localResponding, setLocalResponding] = useState(false);
  
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
  
  // Reset local responding when isResponding changes from true to false
  useEffect(() => {
    if (!isResponding && localResponding) {
      setLocalResponding(false);
    }
  }, [isResponding, localResponding]);
  
  // Auto-clear answer after successful submit (optional - based on use case)
  // This is commented out because typically you want to keep the answer visible
  
  // Handle Enter key to submit (with Ctrl/Cmd)
  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !disabled && answer.trim() && !isResponding && !localResponding) {
      e.preventDefault();
      e.stopPropagation();
      handleSubmit();
    }
  };
  
  // Handle submit with debouncing to prevent double submission
  const handleSubmit = () => {
    const now = Date.now();
    
    // Prevent double submission within 2 seconds
    if (now - lastSubmitTime < 2000) {
      console.log('⚠️ Submit throttled - too frequent');
      return;
    }
    
    if (disabled || aiInterviewerStatus !== 'listening' || answer.trim() === "" || isResponding || localResponding) {
      console.log('Cannot submit:', { 
        disabled, 
        aiInterviewerStatus, 
        hasAnswer: !!answer.trim(), 
        isResponding,
        localResponding 
      });
      return;
    }
    
    console.log('📤 Submitting answer...');
    setLastSubmitTime(now);
    setSubmitAttempts(prev => prev + 1);
    setLocalResponding(true);
    
    // Call the onSubmit prop
    onSubmit();
    
    // Safety timeout to reset local responding if parent doesn't
    setTimeout(() => {
      setLocalResponding(false);
    }, 10000);
  };
  
  // Get status indicator with enhanced states
  const getStatusInfo = () => {
    switch(aiInterviewerStatus) {
      case 'speaking': 
        return { color: '#9b59b6', icon: '📝', text: 'AI is preparing question...', isActive: true };
      case 'listening': 
        return { color: '#27ae60', icon: '👂', text: 'Waiting for your response...', isActive: true };
      case 'analyzing': 
        return { color: '#f39c12', icon: '🔍', text: 'Analyzing your answer...', isActive: true };
      case 'error': 
        return { color: '#e74c3c', icon: '⚠️', text: 'AI encountered an error', isActive: false };
      case 'generating': 
        return { color: '#3498db', icon: '⚙️', text: 'Generating next question...', isActive: true };
      case 'resume_analyzing': 
        return { color: '#8e44ad', icon: '📄', text: 'Analyzing resume for questions...', isActive: true };
      case 'connected':
        return { color: '#2ecc71', icon: '🔌', text: 'AI Interviewer Connected', isActive: true };
      case 'complete':
        return { color: '#27ae60', icon: '✅', text: 'Interview Complete!', isActive: false };
      case 'idle':
        return { color: '#7f8c8d', icon: '🤖', text: 'AI Interviewer Ready', isActive: false };
      case 'disconnected':
        return { color: '#e74c3c', icon: '🔌', text: 'AI Disconnected - Reconnecting...', isActive: false };
      default: 
        return { color: '#7f8c8d', icon: '🤖', text: 'AI Interviewer Ready', isActive: false };
    }
  };

  const statusInfo = getStatusInfo();
  
  // Determine if submit button should be disabled
  const isSubmitDisabled = disabled || 
    aiInterviewerStatus !== 'listening' || 
    answer.trim() === "" || 
    isResponding || 
    localResponding;
  
  // Determine if textarea should be disabled
  const isTextareaDisabled = aiInterviewerStatus !== 'listening' || disabled;
  
  // Get appropriate placeholder text
  const getPlaceholderText = () => {
    if (aiInterviewerStatus === 'listening') {
      return "Type your answer here. Press Ctrl+Enter to submit.";
    } else if (aiInterviewerStatus === 'speaking' || aiInterviewerStatus === 'generating') {
      return "AI is preparing the next question...";
    } else if (aiInterviewerStatus === 'analyzing') {
      return "AI is analyzing your previous answer...";
    } else if (aiInterviewerStatus === 'complete') {
      return "Interview completed! Thank you for participating.";
    } else if (aiInterviewerStatus === 'connected') {
      return "AI Interviewer is ready. Waiting for first question...";
    } else {
      return "Type your answer here...";
    }
  };

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
          className={`participant-ai-status-indicator ${statusInfo.isActive ? 'active' : ''}`}
          style={{ backgroundColor: statusInfo.color }}
        >
          <span className="participant-ai-status-icon">{statusInfo.icon}</span>
          <span className="participant-ai-status-text">{statusInfo.text}</span>
          {statusInfo.isActive && (
            <span className="participant-ai-status-pulse"></span>
          )}
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
        
        {/* Response Progress Indicator */}
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
            <span className={`participant-progress-stat ${wordCount < 30 ? 'warning' : wordCount >= 50 ? 'good' : ''}`}>
              <span className="participant-stat-icon">📝</span>
              {wordCount} {wordCount === 1 ? 'word' : 'words'}
              {wordCount < 30 && ' (Aim for 50+ words)'}
              {wordCount >= 50 && ' ✓ Great length!'}
            </span>
            <span className={`participant-progress-stat ${charCount > 500 ? 'warning' : ''}`}>
              <span className="participant-stat-icon">✍️</span>
              {charCount}/500 characters
              {charCount > 500 && ' (Too long!)'}
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
            className={`participant-response-textarea ${aiInterviewerStatus === 'listening' ? 'active' : ''}`}
            placeholder={getPlaceholderText()}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isTextareaDisabled}
            rows="6"
            maxLength="2000"
          />
          
          {/* Character Counter & Controls */}
          <div className="participant-response-controls">
            <div className="participant-char-counter">
              <span className={`participant-counter ${charCount > 500 ? 'warning' : charCount > 300 ? 'info' : ''}`}>
                📝 {charCount}/500 characters • {wordCount} words
              </span>
              {isTyping && <span className="participant-typing-indicator">✍️ Typing...</span>}
            </div>
            
            <div className="participant-submit-section">
              <button
                className={`participant-submit-button ${isSubmitDisabled ? 'disabled' : 'active'}`}
                disabled={isSubmitDisabled}
                onClick={handleSubmit}
              >
                {(isResponding || localResponding) ? (
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
              <li>Be specific and provide real-world examples</li>
              <li>Aim for 50-100 words per answer for better scores</li>
              <li>Structure your answer clearly (Situation, Task, Action, Result)</li>
              <li>Relate answers to your resume experience and skills</li>
              <li>Use technical terms relevant to the question</li>
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
            {currentQuestionNumber} of {totalQuestions} questions answered
          </span>
          <span className="participant-interview-stat">
            <span className="participant-stat-icon">📊</span>
            {Math.round((currentQuestionNumber / totalQuestions) * 100)}% Complete
          </span>
          <span className="participant-interview-stat">
            <span className="participant-stat-icon">⏱️</span>
            Est. remaining: {Math.max(0, Math.round((totalQuestions - currentQuestionNumber) * 2))} min
          </span>
        </div>
      </div>
      
      {/* Feedback Section - Optional, can be shown when answer is submitted */}
      {/* This can be uncommented if you want to show immediate feedback */}
      {/*
      {feedback && (
        <div className={`participant-feedback ${feedback.score >= 7 ? 'positive' : feedback.score >= 4 ? 'neutral' : 'negative'}`}>
          <div className="participant-feedback-score">
            Score: {feedback.score}/10
          </div>
          <div className="participant-feedback-message">
            {feedback.message}
          </div>
        </div>
      )}
      */}
    </div>
  );
}

export default ParticipantAIInterviewQA;