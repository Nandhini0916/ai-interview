import React, { useState, useEffect, useRef, useCallback } from "react";
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
  resumeUploaded = false,
  voiceEnabled = true,
  showVoiceInput = true,
  onVoiceTranscript
}) {
  const [isTyping, setIsTyping] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [submitAttempts, setSubmitAttempts] = useState(0);
  const [lastSubmitTime, setLastSubmitTime] = useState(0);
  const [localResponding, setLocalResponding] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState(null);
  const [showTips, setShowTips] = useState(true);
  
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  const textareaRef = useRef(null);
  const streamRef = useRef(null);
  
  // Calculate word and character counts
  useEffect(() => {
    const trimmedAnswer = answer?.trim() || "";
    setCharCount(trimmedAnswer.length);
    setWordCount(trimmedAnswer ? trimmedAnswer.split(/\s+/).filter(word => word.length > 0).length : 0);
  }, [answer]);
  
  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 150) + 'px';
    }
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
  
  // Speak question when AI is in speaking mode
  useEffect(() => {
    if (voiceEnabled && question && aiInterviewerStatus === 'speaking') {
      speakQuestion();
    }
  }, [question, aiInterviewerStatus, voiceEnabled]);
  
  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);
  
  const speakQuestion = () => {
    if (!voiceEnabled || !window.speechSynthesis) return;
    
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(question);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    utterance.lang = 'en-US';
    
    // Try to get a good voice
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(voice => 
      voice.lang === 'en-US' && !voice.name.includes('Microsoft')
    );
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }
    
    utterance.onend = () => {
      console.log('Question speaking completed');
    };
    
    window.speechSynthesis.speak(utterance);
  };
  
  // Start voice recording
  const startRecording = async () => {
    if (disabled || aiInterviewerStatus !== 'listening') {
      alert("Please wait for the AI to finish speaking before recording.");
      return;
    }
    
    setTranscriptionError(null);
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { 
          type: mediaRecorder.mimeType || 'audio/webm' 
        });
        await transcribeAudio(audioBlob);
        
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }
      };
      
      mediaRecorder.start(100);
      setIsRecording(true);
      setRecordingTime(0);
      
      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      
    } catch (err) {
      console.error('Error accessing microphone:', err);
      alert('Could not access microphone. Please check permissions and try again.');
    }
  };
  
  // Stop recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };
  
  // Transcribe audio to text
  const transcribeAudio = async (blob) => {
    setIsTranscribing(true);
    
    try {
      const formData = new FormData();
      formData.append('audio', blob, 'recording.webm');
      
      const response = await fetch('http://localhost:8001/voice/transcribe', {
        method: 'POST',
        body: formData
      });
      
      const result = await response.json();
      
      if (result.success && result.text) {
        const transcribedText = result.text;
        
        // Update answer field
        if (answer && answer.trim()) {
          setAnswer(answer + " " + transcribedText);
        } else {
          setAnswer(transcribedText);
        }
        
        // Call the voice transcript callback if provided
        if (onVoiceTranscript) {
          onVoiceTranscript(transcribedText);
        }
        
        // Auto-submit after short delay
        setTimeout(() => {
          if (transcribedText.trim() && aiInterviewerStatus === 'listening' && !localResponding && !isResponding) {
            handleSubmit();
          }
        }, 1000);
      } else {
        setTranscriptionError(result.error || 'Failed to transcribe audio');
      }
    } catch (err) {
      console.error('Transcription error:', err);
      setTranscriptionError('Network error. Please type your answer.');
    } finally {
      setIsTranscribing(false);
    }
  };
  
  // Handle Enter key to submit (with Ctrl/Cmd)
  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !disabled && answer?.trim() && !isResponding && !localResponding) {
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
    
    if (disabled || aiInterviewerStatus !== 'listening' || !answer?.trim() || isResponding || localResponding) {
      console.log('Cannot submit:', { 
        disabled, 
        aiInterviewerStatus, 
        hasAnswer: !!answer?.trim(), 
        isResponding,
        localResponding 
      });
      if (aiInterviewerStatus !== 'listening') {
        alert("Please wait for AI to finish speaking before submitting.");
      } else if (!answer?.trim()) {
        alert("Please enter or record your answer before submitting.");
      }
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
  
  // Format time for recording display
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
  
  // Get status indicator with enhanced states
  const getStatusInfo = () => {
    switch(aiInterviewerStatus) {
      case 'speaking': 
        return { color: '#9b59b6', icon: '📝', text: 'AI is speaking...', isActive: true };
      case 'listening': 
        return { color: '#27ae60', icon: '👂', text: 'Listening for your response...', isActive: true };
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
    !answer?.trim() || 
    isResponding || 
    localResponding;
  
  // Determine if textarea should be disabled
  const isTextareaDisabled = aiInterviewerStatus !== 'listening' || disabled;
  
  // Get appropriate placeholder text
  const getPlaceholderText = () => {
    if (aiInterviewerStatus === 'listening') {
      return "Type your answer here. Press Ctrl+Enter to submit.";
    } else if (aiInterviewerStatus === 'speaking' || aiInterviewerStatus === 'generating') {
      return "AI is speaking... Please wait for your turn.";
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
          {voiceEnabled && aiInterviewerStatus === 'speaking' && (
            <span className="speaking-badge">🔊 Speaking...</span>
          )}
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
          {aiInterviewerStatus === 'listening' && (
            <span className="listening-badge">🎤 Ready for your answer</span>
          )}
        </div>
        
        {/* Voice Recording Section */}
        {voiceEnabled && showVoiceInput && (
          <div className="participant-voice-recorder">
            {!isRecording ? (
              <button
                type="button"
                onClick={startRecording}
                disabled={disabled || aiInterviewerStatus !== 'listening' || isTranscribing}
                className={`voice-record-button ${aiInterviewerStatus === 'listening' ? 'ready' : ''}`}
              >
                <span className="voice-icon">🎤</span>
                {isTranscribing ? 'Transcribing...' : 'Record Voice Answer'}
              </button>
            ) : (
              <div className="recording-controls">
                <div className="recording-indicator">
                  <span className="recording-dot"></span>
                  <span className="recording-time">{formatTime(recordingTime)}</span>
                </div>
                <button onClick={stopRecording} className="stop-record-button">
                  ⏹️ Stop Recording
                </button>
              </div>
            )}
            {transcriptionError && (
              <div className="transcription-error">
                ⚠️ {transcriptionError}
              </div>
            )}
            {voiceEnabled && aiInterviewerStatus === 'listening' && !isRecording && !isTranscribing && (
              <div className="voice-hint">
                💡 Click the microphone to record your answer, or type below
              </div>
            )}
          </div>
        )}
        
        {/* Text Input Section */}
        <div className="participant-response-container">
          <textarea
            ref={textareaRef}
            className={`participant-response-textarea ${aiInterviewerStatus === 'listening' ? 'active' : ''}`}
            placeholder={getPlaceholderText()}
            value={answer || ""}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isTextareaDisabled}
            rows="5"
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
                className={`participant-submit-button ${!isSubmitDisabled ? 'active' : ''}`}
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
          
          {/* Response Tips - Collapsible */}
          <div className="participant-response-tips">
            <div 
              className="participant-tips-header"
              onClick={() => setShowTips(!showTips)}
            >
              <span className="participant-tips-icon">💡</span>
              <span>Tips for a good answer</span>
              <span className="participant-tips-toggle">{showTips ? '▼' : '▲'}</span>
            </div>
            {showTips && (
              <ul className="participant-tips-list">
                <li>Be specific and provide real-world examples</li>
                <li>Aim for 50-100 words per answer for better scores</li>
                <li>Structure your answer clearly (Situation, Task, Action, Result)</li>
                <li>Relate answers to your resume experience and skills</li>
                <li>Use technical terms relevant to the question</li>
              </ul>
            )}
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
    </div>
  );
}

export default ParticipantAIInterviewQA;