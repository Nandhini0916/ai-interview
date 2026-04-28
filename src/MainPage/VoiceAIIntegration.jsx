// VoiceAIIntegration.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';

export const useVoiceAI = () => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState(null);
  const [voices, setVoices] = useState([]);
  
  const synthesisRef = useRef(null);
  const recognitionRef = useRef(null);
  const utteranceQueue = useRef([]);
  const isPlayingRef = useRef(false);

  // Initialize speech synthesis
  useEffect(() => {
    if (!window.speechSynthesis) {
      setError('Speech synthesis not supported in this browser');
      return;
    }

    synthesisRef.current = window.speechSynthesis;
    
    // Load available voices
    const loadVoices = () => {
      const availableVoices = synthesisRef.current.getVoices();
      setVoices(availableVoices);
    };
    
    loadVoices();
    if (synthesisRef.current.onvoiceschanged !== undefined) {
      synthesisRef.current.onvoiceschanged = loadVoices;
    }
    
    return () => {
      if (synthesisRef.current) {
        synthesisRef.current.cancel();
      }
    };
  }, []);

  // Initialize speech recognition
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    
    if (!SpeechRecognition) {
      setError('Speech recognition not supported in this browser');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      setTranscript('');
      setError(null);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.onresult = (event) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (finalTranscript) {
        setTranscript(finalTranscript);
        setIsListening(false);
        recognition.stop();
      } else if (interimTranscript) {
        setTranscript(interimTranscript);
      }
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      setError(`Recognition error: ${event.error}`);
      setIsListening(false);
    };

    recognitionRef.current = recognition;

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.abort();
      }
    };
  }, []);

  // Speak text with queue management
  const speak = useCallback((text, options = {}) => {
    if (!synthesisRef.current || !text) return;

    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);
      
      // Configure voice
      utterance.rate = options.rate || 1.0;
      utterance.pitch = options.pitch || 1.0;
      utterance.volume = options.volume || 1.0;
      utterance.lang = options.lang || 'en-US';
      
      // Select preferred voice if available
      if (options.voiceName && voices.length > 0) {
        const selectedVoice = voices.find(v => v.name === options.voiceName);
        if (selectedVoice) utterance.voice = selectedVoice;
      }

      utterance.onstart = () => {
        setIsSpeaking(true);
        isPlayingRef.current = true;
      };

      utterance.onend = () => {
        setIsSpeaking(false);
        isPlayingRef.current = false;
        
        // Process next in queue
        if (utteranceQueue.current.length > 0) {
          const next = utteranceQueue.current.shift();
          synthesisRef.current.speak(next.utterance);
          next.resolve();
        } else {
          resolve();
        }
      };

      utterance.onerror = (event) => {
        console.error('Speech error:', event);
        setIsSpeaking(false);
        isPlayingRef.current = false;
        reject(event);
      };

      // Queue or play immediately
      if (isPlayingRef.current) {
        utteranceQueue.current.push({ utterance, resolve, reject });
      } else {
        synthesisRef.current.speak(utterance);
      }
    });
  }, [voices]);

  // Start listening for user input
  const startListening = useCallback(() => {
    if (!recognitionRef.current) {
      setError('Speech recognition not available');
      return Promise.reject('Speech recognition not available');
    }

    if (isListening) {
      recognitionRef.current.stop();
    }

    return new Promise((resolve) => {
      recognitionRef.current.onend = () => {
        setIsListening(false);
        resolve(transcript);
      };
      
      recognitionRef.current.start();
    });
  }, [transcript, isListening]);

  // Stop listening
  const stopListening = useCallback(() => {
    if (recognitionRef.current && isListening) {
      recognitionRef.current.stop();
    }
  }, [isListening]);

  // Cancel all speech
  const cancelSpeech = useCallback(() => {
    if (synthesisRef.current) {
      synthesisRef.current.cancel();
      utteranceQueue.current = [];
      setIsSpeaking(false);
      isPlayingRef.current = false;
    }
  }, []);

  return {
    speak,
    startListening,
    stopListening,
    cancelSpeech,
    isSpeaking,
    isListening,
    transcript,
    error,
    voices,
    setTranscript
  };
};

// Voice Question Component for AI Interviewer
export const VoiceAIQuestion = ({ question, onAnswerReceived, onSpeakingComplete }) => {
  const [state, setState] = useState('idle'); // idle, speaking, listening, processing
  const [answer, setAnswer] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  
  const { speak, startListening, stopListening, isSpeaking, isListening, transcript, error } = useVoiceAI();

  // Speak question when component mounts or question changes
  useEffect(() => {
    if (question && state === 'idle') {
      askQuestion();
    }
  }, [question]);

  const askQuestion = async () => {
    setState('speaking');
    setAnswer('');
    
    try {
      await speak(question, { rate: 0.95 });
      setState('listening');
      if (onSpeakingComplete) onSpeakingComplete();
      
      // Start listening for answer
      const userAnswer = await startListening();
      setAnswer(userAnswer);
      setState('processing');
      
      // Send answer for evaluation
      if (onAnswerReceived) {
        await onAnswerReceived(userAnswer);
      }
      
      setState('idle');
      setRetryCount(0);
    } catch (err) {
      console.error('Voice interaction error:', err);
      setState('error');
      
      if (retryCount < 2) {
        setRetryCount(prev => prev + 1);
        setTimeout(() => {
          setState('idle');
          askQuestion();
        }, 2000);
      }
    }
  };

  const retryListening = async () => {
    setState('listening');
    const userAnswer = await startListening();
    setAnswer(userAnswer);
    setState('processing');
    
    if (onAnswerReceived) {
      await onAnswerReceived(userAnswer);
    }
    
    setState('idle');
  };

  return (
    <div className="voice-ai-question">
      <div className="question-status">
        {state === 'speaking' && (
          <div className="status speaking">
            <div className="wave-animation"></div>
            <span>🤖 AI is speaking...</span>
          </div>
        )}
        {state === 'listening' && (
          <div className="status listening">
            <div className="pulse-animation"></div>
            <span>🎤 Listening for your answer...</span>
            <button onClick={stopListening} className="stop-listening-btn">
              Stop Recording
            </button>
          </div>
        )}
        {state === 'processing' && (
          <div className="status processing">
            <div className="spinner"></div>
            <span>🤔 Evaluating your answer...</span>
          </div>
        )}
        {state === 'error' && (
          <div className="status error">
            <span>⚠️ {error || 'Voice recognition failed'}</span>
            <button onClick={retryListening} className="retry-btn">
              Retry Answer
            </button>
          </div>
        )}
      </div>
      
      {answer && state !== 'listening' && (
        <div className="answer-preview">
          <strong>Your answer:</strong>
          <p>{answer}</p>
        </div>
      )}
    </div>
  );
};

// Voice Answer Component for Participant
export const VoiceAnswer = ({ onAnswerSubmit, disabled, expectedDuration = 30 }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [timeLeft, setTimeLeft] = useState(expectedDuration);
  const [audioBlob, setAudioBlob] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timerRef = useRef(null);

  const startRecording = async () => {
    if (disabled) return;
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        setAudioBlob(audioBlob);
        
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
        
        // Send to server for transcription
        setIsProcessing(true);
        const transcribedText = await transcribeAudio(audioBlob);
        setIsProcessing(false);
        
        if (transcribedText && onAnswerSubmit) {
          onAnswerSubmit(transcribedText);
        }
      };
      
      mediaRecorder.start();
      setIsRecording(true);
      setTimeLeft(expectedDuration);
      
      // Start timer
      timerRef.current = setInterval(() => {
        setTimeLeft(prev => {
          if (prev <= 1) {
            stopRecording();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      
    } catch (err) {
      console.error('Error accessing microphone:', err);
      alert('Could not access microphone. Please check permissions.');
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
    // Method 1: Browser's Web Speech API (if recording was short)
    // This is simpler but less accurate for long answers
    
    // Method 2: Send to backend for Whisper/Google STT
    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');
    
    try {
      const response = await fetch('http://localhost:8001/transcribe', {
        method: 'POST',
        body: formData
      });
      
      const data = await response.json();
      return data.text || '';
    } catch (err) {
      console.error('Transcription error:', err);
      return '';
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && isRecording) {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  return (
    <div className="voice-answer">
      {!isRecording ? (
        <button 
          onClick={startRecording} 
          disabled={disabled || isProcessing}
          className="record-button"
        >
          {isProcessing ? (
            <>⏳ Processing...</>
          ) : (
            <>🎤 Record Your Answer</>
          )}
        </button>
      ) : (
        <div className="recording-indicator">
          <div className="recording-pulse"></div>
          <span>Recording... {timeLeft}s remaining</span>
          <button onClick={stopRecording} className="stop-record-btn">
            ⏹️ Stop Recording
          </button>
        </div>
      )}
      
      <p className="voice-hint">
        💡 Tip: Speak clearly and at a moderate pace. Your answer will be automatically transcribed.
      </p>
    </div>
  );
};

export default { useVoiceAI, VoiceAIQuestion, VoiceAnswer };