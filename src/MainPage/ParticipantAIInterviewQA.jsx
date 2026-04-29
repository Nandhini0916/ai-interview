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
  const [hasSpokenQuestion, setHasSpokenQuestion] = useState(false);
  const [answerSubmitted, setAnswerSubmitted] = useState(false);
  
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  const textareaRef = useRef(null);
  const streamRef = useRef(null);
  const currentUtteranceRef = useRef(null);
  const submitTimeoutRef = useRef(null);
  
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
      setAnswerSubmitted(false);
    }
  }, [isResponding, localResponding]);
  
  // Speak question when AI is in speaking mode - ONLY ONCE per question
  useEffect(() => {
    if (voiceEnabled && question && aiInterviewerStatus === 'speaking' && !hasSpokenQuestion) {
      setHasSpokenQuestion(true);
      speakQuestion();
    }
    return () => {
      if (currentUtteranceRef.current) {
        window.speechSynthesis.cancel();
      }
    };
  }, [question, aiInterviewerStatus, voiceEnabled, hasSpokenQuestion]);
  
  // Reset hasSpokenQuestion when question changes
  useEffect(() => {
    setHasSpokenQuestion(false);
    setAnswerSubmitted(false);
    // Clear any pending submit timeout
    if (submitTimeoutRef.current) {
      clearTimeout(submitTimeoutRef.current);
      submitTimeoutRef.current = null;
    }
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
  
  const speakQuestion = () => {
    if (!voiceEnabled || !window.speechSynthesis || !question) return;
    
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(question);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    utterance.lang = 'en-US';
    
    // Try to get available voices
    const speakWithVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      const preferredVoice = voices.find(voice => 
        voice.lang === 'en-US' && !voice.name.includes('Microsoft') && voice.name.includes('Google')
      ) || voices.find(voice => voice.lang === 'en-US');
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }
    };
    
    if (window.speechSynthesis.getVoices().length === 0) {
      window.speechSynthesis.onvoiceschanged = speakWithVoices;
    } else {
      speakWithVoices();
    }
    
    utterance.onstart = () => {
      console.log('🗣️ AI question speaking started');
    };
    
    utterance.onend = () => {
      console.log('🗣️ AI question speaking completed');
    };
    
    utterance.onerror = (event) => {
      console.error('Speech synthesis error:', event);
    };
    
    currentUtteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  };
  
  // Start voice recording
  const startRecording = async () => {
    if (disabled || aiInterviewerStatus !== 'listening') {
      const statusMessages = {
        'speaking': 'Please wait for AI to finish speaking before recording.',
        'analyzing': 'AI is analyzing your previous answer. Please wait.',
        'idle': 'AI Interviewer is not active. Please wait for a question.',
        'complete': 'Interview is complete. Thank you for participating!',
        'connected': 'AI is preparing your first question. Please wait...'
      };
      alert(statusMessages[aiInterviewerStatus] || `AI is currently ${aiInterviewerStatus}. Please wait.`);
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
        
        if (answer && answer.trim()) {
          setAnswer(answer + " " + transcribedText);
        } else {
          setAnswer(transcribedText);
        }
        
        if (onVoiceTranscript) {
          onVoiceTranscript(transcribedText);
        }
        
        // Auto-submit after transcription
        if (transcribedText.trim() && aiInterviewerStatus === 'listening' && !localResponding && !isResponding && !answerSubmitted) {
          // Small delay to allow user to see the transcribed text
          submitTimeoutRef.current = setTimeout(() => {
            handleSubmit();
          }, 500);
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
      
      if (!disabled && answer?.trim() && !isResponding && !localResponding && aiInterviewerStatus === 'listening' && !answerSubmitted) {
        handleSubmit();
      }
    }
  };
  
  // Handle submit with debouncing to prevent double submission
  const handleSubmit = () => {
    const now = Date.now();
    
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
    
    // Validate submission conditions
    if (disabled) {
      console.log('⚠️ Submit blocked: Component is disabled');
      return;
    }
    
    if (aiInterviewerStatus !== 'listening') {
      const statusMessages = {
        'speaking': 'Please wait for AI to finish speaking before submitting.',
        'analyzing': 'AI is analyzing your previous answer. Please wait.',
        'idle': 'AI Interviewer is not active. Please wait for a question.',
        'complete': 'Interview is complete. Thank you for participating!',
        'connected': 'AI is preparing your first question. Please wait...'
      };
      alert(statusMessages[aiInterviewerStatus] || `AI is currently ${aiInterviewerStatus}. Please wait.`);
      return;
    }
    
    if (!answer?.trim()) {
      alert("Please enter or record your answer before submitting.");
      return;
    }
    
    if (isResponding || localResponding) {
      console.log('⚠️ Submit blocked: Already responding');
      return;
    }
    
    console.log('📤 Submitting answer:', answer.substring(0, 100));
    console.log('📤 Question:', question?.substring(0, 100));
    console.log('📤 Word count:', wordCount);
    
    setLastSubmitTime(now);
    setSubmitAttempts(prev => prev + 1);
    setLocalResponding(true);
    setAnswerSubmitted(true);
    
    // Clear any pending submit timeout
    if (submitTimeoutRef.current) {
      clearTimeout(submitTimeoutRef.current);
      submitTimeoutRef.current = null;
    }
    
    // Call the onSubmit prop from parent
    onSubmit();
    
    // Reset local responding after a delay (fallback in case parent doesn't reset)
    setTimeout(() => {
      setLocalResponding(false);
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
    aiInterviewerStatus !== 'listening' || 
    !answer?.trim() || 
    isResponding || 
    localResponding ||
    answerSubmitted;
  
  // Determine if textarea should be disabled
  const isTextareaDisabled = aiInterviewerStatus !== 'listening' || disabled || isResponding || answerSubmitted;
  
  // Determine if voice recording should be disabled
  const isVoiceDisabled = disabled || aiInterviewerStatus !== 'listening' || isResponding || localResponding || answerSubmitted;
  
  // Get appropriate placeholder text
  const getPlaceholderText = () => {
    if (answerSubmitted) {
      return "Answer submitted! Waiting for AI response...";
    } else if (aiInterviewerStatus === 'listening') {
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

  const isTextareaEnabled = aiInterviewerStatus === 'listening' && !isResponding && !disabled && !answerSubmitted;

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
          {aiInterviewerStatus === 'listening' && !answerSubmitted && (
            <span className="listening-badge">🎤 Ready for your answer</span>
          )}
          {answerSubmitted && (
            <span className="submitted-badge">✓ Answer Submitted</span>
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
                className={`voice-record-button ${aiInterviewerStatus === 'listening' && !isResponding && !localResponding && !answerSubmitted ? 'ready' : ''}`}
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
            {voiceEnabled && aiInterviewerStatus === 'listening' && !isRecording && !isTranscribing && !isResponding && !localResponding && !answerSubmitted && (
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
                setAnswer(e.target.value);
              }
            }}
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