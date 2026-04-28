import React, { useState, useEffect, useRef, useCallback } from "react";
import "./AIInterviewQA.css";

// Voice Recording Component
const VoiceRecorder = ({ onTranscript, disabled, isListening }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState(null);
  
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);
  const streamRef = useRef(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const startRecording = async () => {
    if (disabled || isListening !== 'listening') {
      alert("Please wait for the AI to finish speaking before recording.");
      return;
    }

    setTranscriptionError(null);
    setAudioBlob(null);
    
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
        setAudioBlob(audioBlob);
        await transcribeAudio(audioBlob);
        
        // Stop all tracks
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(track => track.stop());
          streamRef.current = null;
        }
      };
      
      mediaRecorder.start(100); // Collect data every 100ms
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
        if (onTranscript) {
          onTranscript(result.text);
        }
      } else {
        setTranscriptionError(result.error || 'Failed to transcribe audio');
        console.error('Transcription failed:', result);
      }
    } catch (err) {
      console.error('Transcription error:', err);
      setTranscriptionError('Network error. Please try typing your answer.');
    } finally {
      setIsTranscribing(false);
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="voice-recorder">
      {!isRecording ? (
        <button
          type="button"
          onClick={startRecording}
          disabled={disabled || isListening !== 'listening' || isTranscribing}
          className={`voice-record-button ${isListening === 'listening' ? 'ready' : ''}`}
          title="Click to record your answer by voice"
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
          <button
            type="button"
            onClick={stopRecording}
            className="stop-record-button"
          >
            ⏹️ Stop Recording
          </button>
        </div>
      )}
      
      {transcriptionError && (
        <div className="transcription-error">
          ⚠️ {transcriptionError}
        </div>
      )}
      
      <div className="voice-hint">
        💡 Tip: Speak clearly at a moderate pace for best results
      </div>
    </div>
  );
};

// Text to Speech Component for AI Voice
const TextToSpeech = ({ text, isSpeaking, onSpeakingComplete, disabled }) => {
  const [speaking, setSpeaking] = useState(false);
  const synthesisRef = useRef(null);
  const utteranceRef = useRef(null);

  useEffect(() => {
    if (!window.speechSynthesis) {
      console.warn('Speech synthesis not supported');
      return;
    }
    synthesisRef.current = window.speechSynthesis;
  }, []);

  useEffect(() => {
    if (text && isSpeaking && !disabled && !speaking) {
      speakText();
    }
  }, [text, isSpeaking, disabled]);

  const speakText = () => {
    if (!synthesisRef.current || !text) return;
    
    // Cancel any ongoing speech
    synthesisRef.current.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    utterance.lang = 'en-US';
    
    // Try to select a good voice
    const voices = synthesisRef.current.getVoices();
    const preferredVoice = voices.find(voice => 
      voice.lang === 'en-US' && !voice.name.includes('Microsoft') && voice.name.includes('Google')
    ) || voices.find(voice => voice.lang === 'en-US');
    
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }
    
    utterance.onstart = () => {
      setSpeaking(true);
    };
    
    utterance.onend = () => {
      setSpeaking(false);
      if (onSpeakingComplete) {
        onSpeakingComplete();
      }
    };
    
    utterance.onerror = (event) => {
      console.error('Speech synthesis error:', event);
      setSpeaking(false);
      if (onSpeakingComplete) {
        onSpeakingComplete();
      }
    };
    
    utteranceRef.current = utterance;
    synthesisRef.current.speak(utterance);
  };

  const stopSpeaking = () => {
    if (synthesisRef.current) {
      synthesisRef.current.cancel();
      setSpeaking(false);
    }
  };

  // Cleanup
  useEffect(() => {
    return () => {
      if (synthesisRef.current) {
        synthesisRef.current.cancel();
      }
    };
  }, []);

  return null;
};

// Main AIInterviewQA Component
function AIInterviewQA({
  currentQuestion,
  candidateResponse,
  setCandidateResponse,
  aiInterviewerStatus,
  onSubmitAnswer,
  enableVoice = true,
  enableTTS = true,
  onVoiceRecordingStarted,
  onVoiceRecordingStopped
}) {
  const [isSpeakingQuestion, setIsSpeakingQuestion] = useState(false);
  const [showVoiceInput, setShowVoiceInput] = useState(true);
  const [answerWordCount, setAnswerWordCount] = useState(0);
  const [answerCharCount, setAnswerCharCount] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef(null);

  // Calculate word and character counts
  useEffect(() => {
    const words = candidateResponse.trim().split(/\s+/);
    setAnswerWordCount(candidateResponse.trim() === "" ? 0 : words.length);
    setAnswerCharCount(candidateResponse.length);
  }, [candidateResponse]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 200) + 'px';
    }
  }, [candidateResponse]);

  // Speak question when status changes to speaking
  useEffect(() => {
    if (enableTTS && aiInterviewerStatus === 'speaking' && currentQuestion) {
      setIsSpeakingQuestion(true);
    } else {
      setIsSpeakingQuestion(false);
    }
  }, [aiInterviewerStatus, currentQuestion, enableTTS]);

  const handleSpeakingComplete = () => {
    setIsSpeakingQuestion(false);
  };

  const handleVoiceTranscript = (transcript) => {
    if (transcript && transcript.trim()) {
      // Append to existing answer or replace?
      if (candidateResponse.trim()) {
        setCandidateResponse(candidateResponse + " " + transcript);
      } else {
        setCandidateResponse(transcript);
      }
      
      // Auto-submit after short delay if configured
      // (optional feature - can be enabled by prop)
    }
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    if (aiInterviewerStatus !== "listening") {
      alert("AI is not listening for answers right now.");
      return;
    }
    if (candidateResponse.trim() === "") {
      alert("Please enter or record your answer before submitting.");
      return;
    }
    
    setIsSubmitting(true);
    try {
      await onSubmitAnswer();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyPress = (e) => {
    // Submit on Ctrl+Enter or Cmd+Enter
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  const getStatusMessage = () => {
    switch(aiInterviewerStatus) {
      case 'speaking':
        return { text: 'AI is speaking...', icon: '🗣️', className: 'speaking' };
      case 'listening':
        return { text: 'Listening for your answer...', icon: '👂', className: 'listening' };
      case 'analyzing':
        return { text: 'Analyzing your answer...', icon: '🔍', className: 'analyzing' };
      case 'complete':
        return { text: 'Interview Complete!', icon: '✅', className: 'complete' };
      default:
        return { text: 'Ready', icon: '🤖', className: 'idle' };
    }
  };

  const status = getStatusMessage();

  return (
    <div className="ai-qa-container">
      {/* AI Interviewer Status */}
      <div className={`ai-status-bar ${status.className}`}>
        <span className="ai-status-icon">{status.icon}</span>
        <span className="ai-status-text">{status.text}</span>
        {aiInterviewerStatus === 'speaking' && enableTTS && (
          <div className="speaking-wave">
            <span></span><span></span><span></span>
          </div>
        )}
        {aiInterviewerStatus === 'listening' && (
          <div className="listening-pulse"></div>
        )}
      </div>

      {/* AI Question Section */}
      <div className="ai-question-section">
        <div className="section-header">
          <span className="section-icon">🤖</span>
          <span className="section-title">AI Interviewer</span>
          {enableTTS && aiInterviewerStatus === 'speaking' && (
            <span className="tts-badge">🔊 Speaking</span>
          )}
        </div>
        <div className="ai-question-box">
          <div className="ai-question-text">
            {currentQuestion || "Waiting for AI question..."}
          </div>
          {currentQuestion && (
            <div className="question-meta">
              <span className="question-word-count">
                📏 {currentQuestion.split(' ').length} words
              </span>
              <span className="question-hint">
                💡 Take your time to answer thoughtfully
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Candidate Answer Section */}
      <div className="candidate-answer-section">
        <div className="section-header">
          <span className="section-icon">👤</span>
          <span className="section-title">Your Answer</span>
          <div className="answer-controls-toggle">
            <button
              type="button"
              onClick={() => setShowVoiceInput(!showVoiceInput)}
              className={`toggle-input-mode ${showVoiceInput ? 'voice-active' : ''}`}
              title={showVoiceInput ? "Hide voice input" : "Show voice input"}
            >
              {showVoiceInput ? '🎤' : '⌨️'}
            </button>
          </div>
        </div>
        
        {/* Voice Input Section */}
        {showVoiceInput && enableVoice && (
          <div className="voice-input-section">
            <VoiceRecorder
              onTranscript={handleVoiceTranscript}
              disabled={isSubmitting}
              isListening={aiInterviewerStatus}
              onRecordingStart={onVoiceRecordingStarted}
              onRecordingStop={onVoiceRecordingStopped}
            />
          </div>
        )}
        
        {/* Text Input Section */}
        <div className="text-input-section">
          <textarea
            ref={textareaRef}
            className="candidate-answer-input"
            placeholder={
              aiInterviewerStatus === 'listening'
                ? "Type your answer here... (Ctrl+Enter to submit)"
                : aiInterviewerStatus === 'speaking'
                ? "Wait for AI to finish speaking..."
                : "Answer input disabled"
            }
            value={candidateResponse}
            onChange={(e) => setCandidateResponse(e.target.value)}
            onKeyDown={handleKeyPress}
            disabled={aiInterviewerStatus !== "listening" || isSubmitting}
            rows={4}
          />
          
          {/* Answer Stats */}
          {candidateResponse && (
            <div className="answer-stats">
              <span className={`stat-word ${answerWordCount < 30 ? 'warning' : answerWordCount >= 50 ? 'good' : ''}`}>
                📝 {answerWordCount} {answerWordCount === 1 ? 'word' : 'words'}
                {answerWordCount < 30 && ' (Aim for 50+ words)'}
              </span>
              <span className={`stat-char ${answerCharCount > 500 ? 'warning' : ''}`}>
                ✍️ {answerCharCount}/500 characters
              </span>
              <span className="stat-shortcut">
                ⌨️ Ctrl+Enter to submit
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Submit Section */}
      <div className="answer-controls">
        <button
          className={`submit-answer-button ${
            aiInterviewerStatus === "listening" && candidateResponse.trim() !== "" && !isSubmitting
              ? 'active'
              : ''
          }`}
          disabled={
            aiInterviewerStatus !== "listening" ||
            candidateResponse.trim() === "" ||
            isSubmitting
          }
          onClick={handleSubmit}
        >
          {isSubmitting ? (
            <>
              <span className="submit-spinner"></span>
              Submitting...
            </>
          ) : (
            <>
              <span className="submit-icon">📤</span>
              Submit Answer
            </>
          )}
        </button>
        
        {aiInterviewerStatus === "listening" && (
          <div className="submit-hint">
            or press <kbd>Ctrl</kbd> + <kbd>Enter</kbd>
          </div>
        )}
      </div>

      {/* Answer Tips */}
      {aiInterviewerStatus === "listening" && (
        <div className="answer-tips">
          <div className="tips-header">💡 Tips for a great answer:</div>
          <ul className="tips-list">
            <li>Be specific and provide real-world examples</li>
            <li>Structure your answer clearly (Situation, Task, Action, Result)</li>
            <li>Aim for 50-100 words for a comprehensive response</li>
            <li>Relate your answer to your experience and skills</li>
          </ul>
        </div>
      )}

      {/* Text to Speech Component */}
      {enableTTS && (
        <TextToSpeech
          text={currentQuestion}
          isSpeaking={isSpeakingQuestion}
          onSpeakingComplete={handleSpeakingComplete}
          disabled={aiInterviewerStatus !== 'speaking'}
        />
      )}
    </div>
  );
}

export default AIInterviewQA;