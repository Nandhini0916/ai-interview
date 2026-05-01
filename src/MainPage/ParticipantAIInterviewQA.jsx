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

  const [answerSubmitted, setAnswerSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  const textareaRef = useRef(null);
  const streamRef = useRef(null);
  const currentUtteranceRef = useRef(null);
  const submitTimeoutRef = useRef(null);
  
  // Debug logging for status changes
  useEffect(() => {
    console.log('🔍 ParticipantAIInterviewQA - Status:', {
      aiInterviewerStatus,
      isResponding,
      disabled,
      answerSubmitted,
      answerLength: answer?.length || 0,
      hasQuestion: !!question
    });
  }, [aiInterviewerStatus, isResponding, disabled, answerSubmitted, answer, question]);
  
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
      console.log('🔄 isResponding turned false - resetting local state');
      setLocalResponding(false);
      setAnswerSubmitted(false);
      setIsSubmitting(false);
    }
  }, [isResponding, localResponding]);
  
  // Safety reset when AI transitions to a ready state
  useEffect(() => {
    const readyStatuses = ['listening', 'idle', 'connected', 'speaking'];
    if (readyStatuses.includes(aiInterviewerStatus) && !isResponding) {
      console.log('👂 AI status is ready - ensuring inputs are enabled');
      setAnswerSubmitted(false);
      setIsSubmitting(false);
      setLocalResponding(false);
    }
  }, [aiInterviewerStatus, isResponding]);
  

  
  // Reset hasSpokenQuestion when question changes
  useEffect(() => {
    setAnswerSubmitted(false);
    setLocalResponding(false);
    setIsSubmitting(false);
  }, [question]);
  
  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (submitTimeoutRef.current) clearTimeout(submitTimeoutRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);
  

  
  // Start voice recording
  const startRecording = async () => {
    const readyStatuses = ['listening', 'idle', 'connected', 'speaking'];
    if (disabled || !readyStatuses.includes(aiInterviewerStatus) || answerSubmitted || isSubmitting) {
      if (aiInterviewerStatus === 'analyzing') {
        alert('AI is analyzing your previous answer. Please wait.');
        return;
      }
      if (aiInterviewerStatus === 'complete') {
        alert('Interview is complete. Thank you for participating!');
        return;
      }
      // If idle/connected/speaking but we have a question, allow it
      if (!question && aiInterviewerStatus === 'idle') {
        alert('AI Interviewer is not active. Please wait for a question.');
        return;
      }
    }
    
    setTranscriptionError(null);
    setRecordingTime(0);
    
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
      
      const response = await fetch('http://localhost:8001/transcribe', {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(15000) // 15 second timeout
      });
      
      const result = await response.json();
      
      if (result.success && result.text) {
        const transcribedText = result.text;
        
        if (answer && answer.trim()) {
          setAnswer(answer + " " + transcribedText);
        } else {
          setAnswer(transcribedText);
        }
        
        if (onVoiceTranscript) {
          onVoiceTranscript(transcribedText);
        }
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
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      
      console.log('📤 Ctrl+Enter pressed - attempting submit');
      
      if (!disabled && answer?.trim() && !isResponding && !localResponding && !isSubmitting && aiInterviewerStatus === 'listening' && !answerSubmitted) {
        console.log('📤 Ctrl+Enter - conditions met, calling submit');
        handleSubmit();
      } else {
        console.log('📤 Ctrl+Enter - conditions not met:', {
          disabled,
          hasAnswer: !!answer?.trim(),
          isResponding,
          localResponding,
          isSubmitting,
          aiInterviewerStatus,
          answerSubmitted
        });
      }
    }
  };
  
  // Handle submit with debouncing to prevent double submission
  const handleSubmit = () => {
    const now = Date.now();
    
    console.log('📤 Submit called - checking conditions');
    console.log('📤 Current state:', {
      disabled,
      aiInterviewerStatus,
      hasAnswer: !!answer?.trim(),
      isResponding,
      localResponding,
      isSubmitting,
      answerSubmitted
    });
    
    // Prevent double submission within 3 seconds
    if (now - lastSubmitTime < 3000) {
      console.log('⚠️ Submit blocked: Too soon after previous submission');
      return;
    }
    
    // Prevent submission if already submitted for this question
    if (answerSubmitted) {
      console.log('⚠️ Submit blocked: Answer already submitted for this question');
      alert("Your answer has already been submitted. Waiting for AI response...");
      return;
    }
    
    // Prevent submission if already submitting
    if (isSubmitting) {
      console.log('⚠️ Submit blocked: Already submitting');
      return;
    }
    
    // Validate submission conditions
    if (disabled) {
      console.log('⚠️ Submit blocked: Component is disabled');
      alert("Answer input is currently disabled. Please wait.");
      return;
    }
    
    // Check if AI is ready (listening, speaking, idle, or connected)
    const readyStatuses = ['listening', 'idle', 'connected', 'speaking'];
    if (!readyStatuses.includes(aiInterviewerStatus)) {
      const statusMessages = {
        'analyzing': 'AI is analyzing your previous answer. Please wait.',
        'complete': 'Interview is complete. Thank you for participating!'
      };
      alert(statusMessages[aiInterviewerStatus] || `AI is currently ${aiInterviewerStatus}. Please wait.`);
      return;
    }
    
    // Safety check for idle state
    if (aiInterviewerStatus === 'idle' && !question) {
      alert("AI Interviewer is not active. Please wait for a question.");
      return;
    }
    
    // Check if answer is not empty
    if (!answer?.trim()) {
      alert("Please enter or record your answer before submitting.");
      return;
    }
    
    // Check if not already responding
    if (isResponding || localResponding) {
      console.log('⚠️ Submit blocked: Already responding');
      alert("Your answer is already being submitted. Please wait.");
      return;
    }
    
    console.log('📤 Submitting answer:', answer.substring(0, 100));
    console.log('📤 Question:', question?.substring(0, 100));
    console.log('📤 Word count:', wordCount);
    
    setLastSubmitTime(now);
    setSubmitAttempts(prev => prev + 1);
    setLocalResponding(true);
    setAnswerSubmitted(true);
    setIsSubmitting(true);
    
    // Clear any pending submit timeout
    if (submitTimeoutRef.current) {
      clearTimeout(submitTimeoutRef.current);
      submitTimeoutRef.current = null;
    }
    
    // Call the onSubmit prop from parent
    try {
      onSubmit();
      
      // Emit a custom event for debugging
      window.dispatchEvent(new CustomEvent('answer-submitted', {
        detail: { answer: answer, timestamp: Date.now() }
      }));
    } catch (error) {
      console.error('❌ Error in onSubmit:', error);
      setAnswerSubmitted(false);
      setLocalResponding(false);
      setIsSubmitting(false);
      alert("Failed to submit answer. Please try again.");
    }
    
    // Reset local responding after a delay (fallback in case parent doesn't reset)
    submitTimeoutRef.current = setTimeout(() => {
      if (localResponding || isSubmitting) {
        console.log('⚠️ Submit timeout - resetting state');
        setLocalResponding(false);
        setIsSubmitting(false);
      }
    }, 15000);
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
        return { color: '#9b59b6', icon: '🗣️', text: 'AI is speaking...', isActive: true };
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
    (aiInterviewerStatus !== 'listening' && aiInterviewerStatus !== 'idle' && aiInterviewerStatus !== 'connected' && aiInterviewerStatus !== 'speaking') || 
    !answer?.trim() || 
    isResponding || 
    isSubmitting;
  
  // Determine if textarea should be disabled
  const isTextareaDisabled = disabled || 
    (aiInterviewerStatus !== 'listening' && aiInterviewerStatus !== 'idle' && aiInterviewerStatus !== 'connected' && aiInterviewerStatus !== 'speaking') || 
    isResponding || 
    isSubmitting;
  
  // Determine if voice recording should be disabled
  const isVoiceDisabled = disabled || 
    (aiInterviewerStatus !== 'listening' && aiInterviewerStatus !== 'idle' && aiInterviewerStatus !== 'connected') || 
    isResponding || 
    isSubmitting;
  
  // Determine if textarea is enabled - more permissive for better UX
  const isTextareaEnabled = !disabled && 
    (aiInterviewerStatus === 'listening' || aiInterviewerStatus === 'idle' || aiInterviewerStatus === 'connected' || aiInterviewerStatus === 'speaking') && 
    !isResponding && 
    !isSubmitting;
  
  // Get appropriate placeholder text
  const getPlaceholderText = () => {
    if (answerSubmitted || isSubmitting) {
      return "✓ Answer submitted! Waiting for AI response...";
    } else if (aiInterviewerStatus === 'listening') {
      return "🎤 AI is listening! Type your answer here. Press Ctrl+Enter to submit.";
    } else if (aiInterviewerStatus === 'speaking') {
      return "🔊 AI is speaking... Please wait for your turn.";
    } else if (aiInterviewerStatus === 'analyzing') {
      return "🤔 AI is analyzing your previous answer...";
    } else if (aiInterviewerStatus === 'complete') {
      return "✅ Interview completed! Thank you for participating.";
    } else if (aiInterviewerStatus === 'connected') {
      return "🤖 AI Interviewer is ready. Waiting for first question...";
    } else {
      return "📝 Type your answer here...";
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
          {aiInterviewerStatus === 'listening' && !answerSubmitted && !isSubmitting && (
            <span className="listening-badge" style={{ backgroundColor: '#27ae60', color: 'white', padding: '2px 8px', borderRadius: '12px', marginLeft: '10px', fontSize: '11px' }}>
              🎤 Ready for your answer
            </span>
          )}
          {(answerSubmitted || isSubmitting) && (
            <span className="submitted-badge" style={{ backgroundColor: '#4caf50', color: 'white', padding: '2px 8px', borderRadius: '12px', marginLeft: '10px', fontSize: '11px' }}>
              {isSubmitting ? '⏳ Sending...' : '✓ Answer Submitted'}
            </span>
          )}
        </div>
        
        {/* Voice Recording Section */}
        {voiceEnabled && showVoiceInput && (
          <div className="participant-voice-recorder">
            {!isRecording ? (
              <button
                type="button"
                onClick={startRecording}
                disabled={isVoiceDisabled || isTranscribing}
                className={`voice-record-button ${aiInterviewerStatus === 'listening' && !isResponding && !isSubmitting ? 'ready' : ''}`}
                style={{
                  opacity: (isVoiceDisabled || isTranscribing) ? 0.5 : 1,
                  cursor: (isVoiceDisabled || isTranscribing) ? 'not-allowed' : 'pointer'
                }}
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
                <button 
                  onClick={() => setTranscriptionError(null)} 
                  style={{ marginLeft: '10px', background: 'none', border: 'none', color: '#ffeb3b', cursor: 'pointer', textDecoration: 'underline', fontSize: '10px' }}
                >
                  Clear
                </button>
              </div>
            )}
            {voiceEnabled && aiInterviewerStatus === 'listening' && !isRecording && !isTranscribing && !isResponding && !isSubmitting && (
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
            className={`participant-response-textarea ${isTextareaEnabled ? 'active' : 'disabled'}`}
            placeholder={getPlaceholderText()}
            value={answer || ""}
            onChange={(e) => {
              if (isTextareaEnabled) {
                console.log('✏️ Answer updated:', e.target.value.substring(0, 50));
                setAnswer(e.target.value);
              }
            }}
            onKeyDown={handleKeyDown}
            disabled={isTextareaDisabled}
            rows="5"
            maxLength="2000"
            style={{
              backgroundColor: isTextareaEnabled ? '#fff' : '#f5f5f5',
              border: isTextareaEnabled ? '2px solid #27ae60' : '1px solid #ddd',
              color: isTextareaEnabled ? '#333' : '#999'
            }}
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
                style={{
                  backgroundColor: !isSubmitDisabled ? '#27ae60' : '#ccc',
                  cursor: !isSubmitDisabled ? 'pointer' : 'not-allowed'
                }}
              >
                {(isResponding || localResponding || isSubmitting) ? (
                  <>
                    <span className="participant-submit-spinner"></span>
                    Sending...
                  </>
                ) : answerSubmitted ? (
                  <>
                    <span className="participant-submit-check">✓</span>
                    Submitted
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
              style={{ cursor: 'pointer' }}
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