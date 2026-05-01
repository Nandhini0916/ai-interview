import React, { useEffect, useState, useRef, useCallback } from "react";
import "./ParticipantRoom.css";
import { createDefaultWebRTCManager } from "../utils/webrtc";
import ParticipantAIInterviewQA from "./ParticipantAIInterviewQA";

const ResumePreview = ({ isResumeUploaded, resumeFile, resumeText, resumeProcessing, onViewResume, onChangeResume }) => {
  if (!isResumeUploaded) {
    return null;
  }

  return (
    <div className="resume-preview-section">
      {resumeFile && (
        <div className="resume-info">
          <span className="file-size">
            {resumeFile.name} ({(resumeFile.size / 1024).toFixed(1)}KB)
          </span>
        </div>
      )}
      <div className="resume-actions">
        <button 
          className="view-resume-button"
          onClick={onViewResume}
          title="View resume content"
          disabled={resumeProcessing}
        >
          {resumeProcessing ? "Loading..." : "Preview"}
        </button>
      
        <button 
          className="change-resume-button"
          onClick={onChangeResume}
          disabled={resumeProcessing}
          title="Upload a different resume file"
        >
          {resumeProcessing ? '⏳ Processing...' : 'Change'}
        </button>
      </div>
    </div>
  );
};

function ParticipantRoom({ room, onLeave }) {
  const [mediaStream, setMediaStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [interviewerStream, setInterviewerStream] = useState(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isInterviewerScreenSharing, setIsInterviewerScreenSharing] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [chatOnline, setChatOnline] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [signalingConnected, setSignalingConnected] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [aiConnected, setAiConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasJoined, setHasJoined] = useState(false);
  const [interviewerConnected, setInterviewerConnected] = useState(false);
  const [connectionRetryCount, setConnectionRetryCount] = useState(0);
  const [isExplicitlyClosing, setIsExplicitlyClosing] = useState(false);
  const [frameCount, setFrameCount] = useState(0);
  
  // Enhanced AI Interviewer states
  const [aiInterviewerActive, setAiInterviewerActive] = useState(false);
  const [aiInterviewerStatus, setAiInterviewerStatus] = useState("idle");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [isListeningForResponse, setIsListeningForResponse] = useState(false);
  const [responseTimeout, setResponseTimeout] = useState(null);
  const [recognition, setRecognition] = useState(null);
  const [responseText, setResponseText] = useState("");
  const [isResponding, setIsResponding] = useState(false);
  const [questionHistory, setQuestionHistory] = useState([]);
  const [responseAnalysis, setResponseAnalysis] = useState(null);
  
  // Voice-specific states
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [showVoiceInput, setShowVoiceInput] = useState(true);
  
  // Enhanced Resume Upload States
  const [resumeFile, setResumeFile] = useState(null);
  const [resumeText, setResumeText] = useState("");
  const [isResumeUploaded, setIsResumeUploaded] = useState(false);
  const [resumeProcessing, setResumeProcessing] = useState(false);
  const [resumeData, setResumeData] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  // Manual mode tracking
  const [isManualMode, setIsManualMode] = useState(true);
  const [interviewMode, setInterviewMode] = useState("manual");

  const videoRef = useRef(null);
  const interviewerVideoRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const canvasRef = useRef(null);
  const frameIntervalRef = useRef(null);
  const wsRef = useRef(null);
  const aiWsRef = useRef(null);
  const webrtcManagerRef = useRef(null);
  const fileInputRef = useRef(null);
  const connectionMonitorRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;
  const reconnectDelay = 3000;

  const PYTHON_API_URL = 'http://localhost:8001';
  const NODE_API_URL = 'http://localhost:8000/api';

  const updateConnectionStatus = (status) => {
    setConnectionStatus(status);
    console.log(`🔗 Participant connection status: ${status}`);
    
    if (status === 'connected') {
      setConnectionRetryCount(0);
      reconnectAttemptsRef.current = 0;
    }
  };

  const extractResumeTextInBrowser = async (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = (event) => {
        try {
          const content = event.target.result;
          let text = '';
          
          if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
            text = content;
          } else if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
            text = `[PDF File: ${file.name}]\n\nFor better PDF parsing, please ensure the Python backend has /upload_resume endpoint running.`;
          } else if (file.type.includes('msword') || file.type.includes('wordprocessingml') || 
                   file.name.endsWith('.doc') || file.name.endsWith('.docx')) {
            text = `[Document File: ${file.name}]\n\nDocument parsing requires server-side processing. The AI will still interview you based on your responses.`;
          } else {
            text = `[File: ${file.name}]\n\nFile uploaded successfully for the interview session.`;
          }
          
          resolve({
            success: true,
            extracted_text: text.substring(0, 5000),
            filename: file.name,
            analysis: {
              skills: [],
              experience_years: 0,
              has_resume: true,
              file_type: file.type || file.name.split('.').pop(),
              file_size: file.size
            }
          });
        } catch (error) {
          reject(new Error(`Failed to read file: ${error.message}`));
        }
      };
      
      reader.onerror = () => {
        reject(new Error('Failed to read file'));
      };
      
      if (file.type === 'text/plain' || file.name.endsWith('.txt')) {
        reader.readAsText(file);
      } else {
        resolve({
          success: true,
          extracted_text: `[File Uploaded: ${file.name}]\n\nFile uploaded successfully. The interviewer has been notified.`,
          filename: file.name,
          analysis: {
            skills: [],
            experience_years: 0,
            has_resume: true,
            file_type: file.type || file.name.split('.').pop(),
            file_size: file.size
          }
        });
      }
    });
  };

  const handleResumeUpload = async (file) => {
    if (!file) return;

    try {
      setResumeProcessing(true);
      setUploadError(null);
      setUploadSuccess(false);
      
      console.log('📄 Starting resume upload:', file.name, file.type, file.size);
      
      const validTypes = ['.pdf', '.doc', '.docx', '.txt'];
      const fileExtension = file.name.split('.').pop().toLowerCase();
      
      if (!validTypes.includes(`.${fileExtension}`)) {
        throw new Error('Please upload PDF, DOC, DOCX, or TXT files only');
      }

      if (file.size > 10 * 1024 * 1024) {
        throw new Error('File size should be less than 10MB');
      }

      if (!isCameraOn) {
        throw new Error('Please turn on your camera first before uploading resume');
      }

      if (!isParticipantVideoReady()) {
        throw new Error('Please ensure your face is clearly visible in the camera with good lighting');
      }
      
      const formData = new FormData();
      formData.append('file', file);
      formData.append('session_id', currentSessionId || `temp-session-${Date.now()}`);
      formData.append('room_id', room.id);
      
      console.log('📤 Uploading to Python backend...');
      console.log('📤 Room ID:', room.id);
      
      const response = await fetch(`${PYTHON_API_URL}/upload_resume`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Python backend upload failed:', errorText);
        throw new Error(`Python backend upload failed: ${response.status} ${response.statusText}`);
      }
      
      const result = await response.json();
      console.log('✅ Resume uploaded to Python backend:', result);
      
      const browserExtraction = await extractResumeTextInBrowser(file);
      
      setResumeText(browserExtraction.extracted_text || result.resume_text || 'Resume uploaded');
      setResumeData(result.analysis || browserExtraction.analysis || { has_resume: true });
      setIsResumeUploaded(true);
      setUploadSuccess(true);
      setResumeFile(file);
      
      addMessage("✅ Resume uploaded successfully! AI can now generate personalized questions.", 'system', new Date().toISOString());
      
      if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat') && !webrtcManagerRef.current.isClosed) {
        webrtcManagerRef.current.sendData('chat', {
          type: 'resume_uploaded',
          resume_text: browserExtraction.extracted_text?.substring(0, 500) || 'Resume uploaded',
          has_resume: true,
          filename: file.name,
          timestamp: new Date().toISOString(),
          room_id: room.id,
          session_id: currentSessionId
        });
      }
      
      if (aiInterviewerActive && aiWsRef.current && aiWsRef.current.readyState === WebSocket.OPEN) {
        aiWsRef.current.send(JSON.stringify({
          type: 'resume_uploaded',
          session_id: currentSessionId,
          resume_text: browserExtraction.extracted_text || 'Resume uploaded',
          resume_analysis: result.analysis || browserExtraction.analysis,
          filename: file.name
        }));
      }
      
      alert('✅ Resume uploaded successfully! The AI interviewer can now start.');
      
    } catch (error) {
      console.error('❌ Error uploading resume:', error);
      setUploadError(error.message);
      setIsResumeUploaded(false);
      setUploadSuccess(false);
      
      addMessage(`❌ Resume upload failed: ${error.message}`, 'system', new Date().toISOString());
      alert(`❌ Resume upload failed: ${error.message}\n\nPlease try again with a different file.`);
    } finally {
      setResumeProcessing(false);
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    console.log('📁 File select event triggered');
    console.log('📁 Selected file:', file);
    
    setUploadError(null);
    setUploadSuccess(false);
    
    const validExtensions = ['.pdf', '.doc', '.docx', '.txt'];
    const hasValidExtension = validExtensions.some(ext => 
      file.name.toLowerCase().endsWith(ext)
    );
    
    if (!hasValidExtension) {
      setUploadError(`Invalid file type: ${file.type}. Please upload PDF, DOC, DOCX, or TXT files only.`);
      addMessage("❌ Invalid file type. Please upload PDF, DOC, DOCX, or TXT files.", 'system', new Date().toISOString());
      return;
    }
    
    if (file.size > 10 * 1024 * 1024) {
      setUploadError(`File too large: ${(file.size / (1024 * 1024)).toFixed(2)}MB. Maximum size is 10MB.`);
      addMessage("❌ File too large. Maximum size is 10MB.", 'system', new Date().toISOString());
      return;
    }
    
    setResumeFile(file);
    console.log('📄 File selected:', file.name, `(${(file.size / 1024).toFixed(2)}KB)`);
    addMessage(`📄 Selected file: ${file.name}`, 'system', new Date().toISOString());
    
    handleResumeUpload(file);
    e.target.value = '';
  };

  const handleViewResume = () => {
    if (resumeText) {
      alert(`Resume Content (Preview):\n\n${resumeText.substring(0, 1000)}${resumeText.length > 1000 ? '...' : ''}`);
    } else {
      alert("Resume text not available for preview.");
    }
  };

  const handleChangeResume = () => {
    console.log('Change resume button clicked');
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // Handle voice transcript
  const handleVoiceTranscript = (transcript) => {
    console.log('🎤 Voice transcript received:', transcript);
    if (transcript && transcript.trim()) {
      if (responseText && responseText.trim()) {
        setResponseText(responseText + " " + transcript);
      } else {
        setResponseText(transcript);
      }
    }
  };

  // Handle candidate response submission - COMPLETELY REWRITTEN FOR RELIABILITY
  const handleCandidateResponse = useCallback(async (response) => {
    const trimmedResponse = response?.trim();
    
    if (!trimmedResponse) {
      console.warn('⚠️ Cannot submit empty response');
      addMessage("⚠️ Please provide an answer before submitting.", 'system', new Date().toISOString());
      return;
    }
    
    if (!aiInterviewerActive) {
      console.warn('⚠️ Cannot submit - AI Interviewer not active');
      addMessage("⚠️ AI Interviewer is not active. Please wait for the interviewer to start the AI session.", 'system', new Date().toISOString());
      return;
    }
    
    if (!currentQuestion) {
      console.warn('⚠️ Cannot submit - No current question');
      addMessage("⚠️ No question available. Please wait for the AI to ask a question.", 'system', new Date().toISOString());
      return;
    }
    
    if (aiInterviewerStatus !== "listening") {
      const statusMessages = {
        'speaking': 'Please wait for AI to finish speaking before submitting.',
        'analyzing': 'AI is analyzing your previous answer. Please wait.',
        'idle': 'AI Interviewer is not active. Please wait for a question.',
        'complete': 'Interview is complete. Thank you for participating!',
        'connected': 'AI is preparing your first question. Please wait...'
      };
      addMessage(`⚠️ ${statusMessages[aiInterviewerStatus] || `AI is currently ${aiInterviewerStatus}. Please wait.`}`, 'system', new Date().toISOString());
      return;
    }
    
    // Prevent double submission
    if (isResponding) {
      console.warn('⚠️ Already submitting an answer');
      return;
    }
    
    setIsResponding(true);
    setIsListeningForResponse(false);
    
    if (responseTimeout) {
      clearTimeout(responseTimeout);
      setResponseTimeout(null);
    }
    
    // Stop speech recognition if active
    if (recognition) {
      try {
        recognition.stop();
      } catch (e) {
        console.warn('Error stopping recognition:', e);
      }
    }
    
    try {
      console.log('📝 Processing candidate response of length:', trimmedResponse.length);
      console.log('📝 Session ID:', currentSessionId);
      
      // Add answer to chat for visual feedback
      addMessage(trimmedResponse, 'participant', new Date().toISOString());
      
      // Clear response text input
      setResponseText("");
      
      // Set status to analyzing
      setAiInterviewerStatus("analyzing");
      addMessage("🤖 AI is analyzing your response...", 'system', new Date().toISOString());
      
      // Submit via REST API
      const submitResponse = await fetch(`${PYTHON_API_URL}/submit_ai_answer`, {
        method: "POST",
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          session_id: currentSessionId,
          question: currentQuestion,
          answer: trimmedResponse
        })
      });
      
      if (!submitResponse.ok) {
        const errorText = await submitResponse.text();
        console.error('❌ API submission failed:', errorText);
        
        let errorMessage = `HTTP ${submitResponse.status}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.message || errorData.error || errorText;
        } catch {
          errorMessage = errorText || submitResponse.statusText;
        }
        
        throw new Error(errorMessage.substring(0, 200));
      }
      
      const result = await submitResponse.json();
      console.log('✅ Answer submitted, result:', result);
      
      // Show feedback score
      if (result.score !== undefined) {
        const feedbackMessage = `📊 Score: ${result.score}/10 - ${result.feedback || 'Good response!'}`;
        setResponseAnalysis({ score: result.score, feedback: result.feedback });
        addMessage(feedbackMessage, 'system', new Date().toISOString());
      }
      
      // Handle next question or completion
      if (result.next_question) {
        console.log('📝 Next question received:', result.next_question);
        
        setAiInterviewerStatus("speaking");
        
        setTimeout(() => {
          setCurrentQuestion(result.next_question);
          addMessage(result.next_question, 'ai_interviewer', new Date().toISOString());
          setQuestionHistory(prev => [...prev, result.next_question]);
          
          // Play TTS for next question
          if (voiceEnabled && 'speechSynthesis' in window) {
            window.speechSynthesis.cancel();
            
            const utterance = new SpeechSynthesisUtterance(result.next_question);
            utterance.rate = 0.95;
            utterance.pitch = 1.0;
            utterance.volume = 1.0;
            utterance.lang = 'en-US';
            
            const voices = window.speechSynthesis.getVoices();
            const preferredVoice = voices.find(voice => 
              voice.lang === 'en-US' && !voice.name.includes('Microsoft') && voice.name.includes('Google')
            ) || voices.find(voice => voice.lang === 'en-US');
            if (preferredVoice) utterance.voice = preferredVoice;
            
            utterance.onstart = () => {
              setAiInterviewerStatus("speaking");
              setIsListeningForResponse(false);
            };
            
            utterance.onend = () => {
              setAiInterviewerStatus("listening");
              setIsListeningForResponse(true);
              addMessage("👂 AI is waiting for your response...", 'system', new Date().toISOString());
            };
            
            utterance.onerror = () => {
              setAiInterviewerStatus("listening");
              setIsListeningForResponse(true);
            };
            
            window.speechSynthesis.speak(utterance);
          } else {
            setTimeout(() => {
              setAiInterviewerStatus("listening");
              setIsListeningForResponse(true);
              addMessage("👂 AI is waiting for your response...", 'system', new Date().toISOString());
            }, 2000);
          }
        }, 1000);
        
      } else if (result.is_complete || result.final_results) {
        console.log('🎉 Interview completed!');
        setAiInterviewerStatus("complete");
        setIsListeningForResponse(false);
        
        const finalMessage = `🎉 AI Interview Completed! Final Score: ${result.final_results?.percentage || result.percentage || 'N/A'}%`;
        addMessage(finalMessage, 'system', new Date().toISOString());
        
        setTimeout(() => {
          setCurrentQuestion("");
          setAiInterviewerActive(false);
          setAiInterviewerStatus("idle");
        }, 5000);
        
      } else {
        console.warn('⚠️ No next question provided, requesting...');
        addMessage("🔄 Loading next question...", 'system', new Date().toISOString());
        
        setTimeout(() => {
          if (aiInterviewerActive) {
            requestAIQuestion();
            setAiInterviewerStatus("listening");
            setIsListeningForResponse(true);
          }
        }, 2000);
      }
      
    } catch (error) {
      console.error('❌ Error handling candidate response:', error);
      addMessage(`❌ Error sending response: ${error.message}`, 'system', new Date().toISOString());
      setAiInterviewerStatus("listening");
      setIsListeningForResponse(true);
    } finally {
      setIsResponding(false);
    }
  }, [aiInterviewerActive, currentQuestion, currentSessionId, aiInterviewerStatus, isResponding, responseTimeout, recognition, voiceEnabled]);

  const requestAIQuestion = () => {
    if (!aiInterviewerActive || !currentSessionId) {
      console.warn('⚠️ Cannot request AI question - prerequisites not met');
      return;
    }
    
    console.log('📥 Requesting AI question from backend...');
    
    fetch(`${PYTHON_API_URL}/start_ai_interview`, {
      method: "POST",
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: currentSessionId,
        level: "medium",
        room_id: room.id
      })
    })
    .then(res => res.json())
    .then(data => {
      if (data.status === "success" && data.questions && data.questions.length > 0) {
        console.log('📝 Got next question via REST:', data.questions[0]);
        const nextQuestion = data.questions[questionHistory.length] || data.questions[0];
        
        setCurrentQuestion(nextQuestion);
        addMessage(nextQuestion, 'ai_interviewer', new Date().toISOString());
        setQuestionHistory(prev => [...prev, nextQuestion]);
        
        setAiInterviewerStatus("speaking");
        setIsListeningForResponse(false);
        
        if (voiceEnabled && 'speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(nextQuestion);
          utterance.rate = 0.95;
          utterance.pitch = 1.0;
          utterance.volume = 1.0;
          utterance.lang = 'en-US';
          
          const voices = window.speechSynthesis.getVoices();
          const preferredVoice = voices.find(voice => 
            voice.lang === 'en-US' && !voice.name.includes('Microsoft') && voice.name.includes('Google')
          ) || voices.find(voice => voice.lang === 'en-US');
          if (preferredVoice) utterance.voice = preferredVoice;
          
          utterance.onstart = () => {
            setAiInterviewerStatus("speaking");
          };
          
          utterance.onend = () => {
            setAiInterviewerStatus("listening");
            setIsListeningForResponse(true);
            addMessage("👂 AI is waiting for your response...", 'system', new Date().toISOString());
          };
          
          window.speechSynthesis.speak(utterance);
        } else {
          setTimeout(() => {
            setAiInterviewerStatus("listening");
            setIsListeningForResponse(true);
          }, 2000);
        }
      } else {
        console.warn('⚠️ No question received from REST API');
        setAiInterviewerStatus("listening");
        setIsListeningForResponse(true);
      }
    })
    .catch(err => {
      console.error('❌ Failed to request next question:', err);
      setAiInterviewerStatus("listening");
      setIsListeningForResponse(true);
    });
  };

  const toggleVoiceInput = () => {
    setShowVoiceInput(!showVoiceInput);
    if (!showVoiceInput && recognition) {
      initializeSpeechRecognition();
    }
  };

  const connectToAIInterviewer = () => {
    if (isExplicitlyClosing) return;
    
    if (aiWsRef.current && aiWsRef.current.readyState === WebSocket.OPEN) {
      console.log('AI WebSocket already connected');
      return;
    }
    
    if (aiWsRef.current && aiWsRef.current.readyState === WebSocket.CONNECTING) {
      console.log('AI WebSocket already connecting');
      return;
    }
    
    try {
      if (aiWsRef.current) {
        if (aiWsRef.current.pingInterval) clearInterval(aiWsRef.current.pingInterval);
        if (aiWsRef.current.pongTimeout) clearTimeout(aiWsRef.current.pongTimeout);
        aiWsRef.current.close();
      }
      
      console.log('🔌 Connecting to AI WebSocket at ws://localhost:8001/ws');
      const ws = new WebSocket("ws://localhost:8001/ws");
      let pingInterval = null;
      let pongTimeout = null;
      
      ws.onopen = () => {
        console.log("✅ Connected to AI WebSocket");
        
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            if (pongTimeout) clearTimeout(pongTimeout);
            pongTimeout = setTimeout(() => {
              console.warn("⚠️ No pong from AI server, reconnecting...");
              if (ws.readyState === WebSocket.OPEN) ws.close();
            }, 10000);
          }
        }, 25000);
        
        if (currentSessionId) {
          console.log('📝 Registering session:', currentSessionId);
          ws.send(JSON.stringify({
            type: 'register_session',
            session_id: currentSessionId,
            room_id: room.id
          }));
          
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              setAiInterviewerActive(true);
              setAiInterviewerStatus("connected");
              console.log('🤖 AI Interviewer connected and registered');
            }
          }, 500);
        } else {
          console.warn('⚠️ No session ID available for registration');
          setAiInterviewerStatus("idle");
        }
        
        addMessage("🤖 Connected to AI Interviewer", 'system', new Date().toISOString());
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'ping') {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
            return;
          }
          
          if (data.type === 'pong') {
            if (pongTimeout) clearTimeout(pongTimeout);
            return;
          }
          
          console.log("🤖 AI WebSocket Message:", data.type);
          
          switch (data.type) {
            case 'session_registered':
              console.log('✅ Session registered successfully:', data);
              setAiInterviewerActive(true);
              setAiInterviewerStatus("connected");
              
              if (isResumeUploaded && !currentQuestion) {
                console.log('📄 Resume uploaded, starting AI interview...');
                setTimeout(() => {
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      type: 'command',
                      command: 'start_ai_interview',
                      session_id: currentSessionId,
                      level: 'medium',
                      room_id: room.id,
                      use_voice: voiceEnabled
                    }));
                  }
                }, 1000);
              } else if (!isResumeUploaded) {
                addMessage("📄 Please upload your resume to start the AI interview.", 'system', new Date().toISOString());
                setAiInterviewerStatus("idle");
              }
              break;
              
            case 'interview_started':
              console.log('🎬 AI interview started:', data);
              setAiInterviewerActive(true);
              
              if (data.questions && data.questions.length > 0) {
                const firstQuestion = data.questions[0];
                console.log('📝 Setting first question:', firstQuestion);
                setCurrentQuestion(firstQuestion);
                addMessage(firstQuestion, 'ai_interviewer', new Date().toISOString());
                setQuestionHistory([firstQuestion]);
                
                setAiInterviewerStatus("speaking");
                setIsListeningForResponse(false);
                
                if (voiceEnabled && 'speechSynthesis' in window) {
                  const utterance = new SpeechSynthesisUtterance(firstQuestion);
                  utterance.rate = 0.95;
                  utterance.pitch = 1.0;
                  utterance.volume = 1.0;
                  utterance.lang = 'en-US';
                  
                  const voices = window.speechSynthesis.getVoices();
                  if (voices.length > 0) {
                    const preferredVoice = voices.find(voice => 
                      voice.lang.includes('en') && !voice.name.includes('Microsoft')
                    );
                    if (preferredVoice) utterance.voice = preferredVoice;
                  }
                  
                  utterance.onstart = () => {
                    setAiInterviewerStatus("speaking");
                    setIsListeningForResponse(false);
                  };
                  
                  utterance.onend = () => {
                    setAiInterviewerStatus("listening");
                    setIsListeningForResponse(true);
                    addMessage("👂 AI is waiting for your response...", 'system', new Date().toISOString());
                  };
                  
                  utterance.onerror = () => {
                    setAiInterviewerStatus("listening");
                    setIsListeningForResponse(true);
                  };
                  
                  window.speechSynthesis.speak(utterance);
                } else {
                  setTimeout(() => {
                    setAiInterviewerStatus("listening");
                    setIsListeningForResponse(true);
                  }, 3000);
                }
              }
              break;
              
            case 'answer_result':
              console.log('📊 Answer result received:', data);
              
              if (data.score !== undefined) {
                addMessage(`📊 Score: ${data.score}/10 - ${data.feedback || 'Good response!'}`, 'system', new Date().toISOString());
              }
              
              if (data.next_question) {
                setAiInterviewerStatus("speaking");
                setIsListeningForResponse(false);
                
                setTimeout(() => {
                  setCurrentQuestion(data.next_question);
                  addMessage(data.next_question, 'ai_interviewer', new Date().toISOString());
                  setQuestionHistory(prev => [...prev, data.next_question]);
                  
                  if (voiceEnabled && 'speechSynthesis' in window) {
                    const utterance = new SpeechSynthesisUtterance(data.next_question);
                    utterance.rate = 0.95;
                    utterance.pitch = 1.0;
                    utterance.volume = 1.0;
                    utterance.lang = 'en-US';
                    
                    utterance.onstart = () => {
                      setAiInterviewerStatus("speaking");
                    };
                    utterance.onend = () => {
                      setAiInterviewerStatus("listening");
                      setIsListeningForResponse(true);
                    };
                    window.speechSynthesis.speak(utterance);
                  } else {
                    setTimeout(() => {
                      setAiInterviewerStatus("listening");
                      setIsListeningForResponse(true);
                    }, 2000);
                  }
                }, 1000);
              } else if (data.is_complete) {
                setAiInterviewerStatus("complete");
                setIsListeningForResponse(false);
                addMessage(`🎉 Interview Completed!`, 'system', new Date().toISOString());
              }
              break;
              
            case 'detection':
              if (data.faces !== undefined) {
                console.log('🔍 Detection update:', data.faces, 'faces,', data.gender);
              }
              break;
              
            case 'error':
              console.error('❌ AI Error:', data.message);
              setAiInterviewerStatus("listening");
              setIsListeningForResponse(true);
              addMessage(`⚠️ ${data.message}`, 'system', new Date().toISOString());
              break;
              
            default:
              console.log('📨 Unknown message type:', data.type);
          }
        } catch (err) {
          console.error("❌ Error parsing AI message:", err);
        }
      };
      
      ws.onclose = (event) => {
        console.log("🔌 AI WebSocket disconnected:", event.code, event.reason);
        if (pingInterval) clearInterval(pingInterval);
        if (pongTimeout) clearTimeout(pongTimeout);
        
        setAiInterviewerActive(false);
        setAiInterviewerStatus("disconnected");
        setIsListeningForResponse(false);
        addMessage("🔌 AI Interviewer disconnected", 'system', new Date().toISOString());
        
        setTimeout(() => {
          if (!isExplicitlyClosing && interviewMode === "ai" && !aiInterviewerActive) {
            console.log("🔄 Attempting to reconnect to AI...");
            connectToAIInterviewer();
          }
        }, 3000);
      };
      
      ws.onerror = (error) => {
        console.error("❌ AI WebSocket error:", error);
        setAiInterviewerStatus("error");
        addMessage("❌ AI connection error", 'system', new Date().toISOString());
      };
      
      aiWsRef.current = ws;
      aiWsRef.current.pingInterval = pingInterval;
      aiWsRef.current.pongTimeout = pongTimeout;
      
    } catch (err) {
      console.error("❌ AI WebSocket connection failed:", err);
      setAiInterviewerActive(false);
      setAiInterviewerStatus("error");
      addMessage("❌ Failed to connect to AI", 'system', new Date().toISOString());
    }
  };

  const handleWebRTCMessage = (data) => {
    console.log('📨 Participant received WebRTC message:', data.type);
    
    if (data.fromSignaling && data.type === 'chat') {
      console.log('💬 Skipping duplicate chat message from signaling');
      return;
    }
    
    if (data.type === 'chat' && data.fromDataChannel) {
      const messageExists = messages.some(msg => 
        msg.id === data.id || 
        (msg.text === data.message && msg.sender === data.sender && Math.abs(new Date(msg.timestamp) - new Date(data.timestamp)) < 1000)
      );
      
      if (!messageExists) {
        addMessage(data.message, data.sender, data.timestamp, data.id);
      }
    } 
    else if (data.type === 'ai_question') {
      console.log('📝 Received AI question via WebRTC:', data.question);
      setCurrentQuestion(data.question);
      
      setQuestionHistory(prev => {
        if (data.question_index === 0) {
          return [data.question];
        }
        if (!prev.includes(data.question)) {
          return [...prev, data.question];
        }
        return prev;
      });
      
      addMessage(data.question, 'ai_interviewer', new Date().toISOString());
      
      if (voiceEnabled && 'speechSynthesis' in window && interviewMode === "ai") {
        speakQuestion(data.question);
      } else if (interviewMode === "ai") {
        setAiInterviewerStatus("speaking");
        setTimeout(() => {
          setAiInterviewerStatus("listening");
          setIsListeningForResponse(true);
          addMessage("👂 AI is waiting for your response...", 'system', new Date().toISOString());
        }, 3000);
      }
    }
    else if (data.type === 'screen_share_state') {
      console.log('🖥️ Interviewer screen share state update:', data.isSharing);
      setIsInterviewerScreenSharing(data.isSharing);
    } 
    else if (data.type === 'ai_interviewer_start') {
      console.log('🤖 AI Interviewer starting via WebRTC:', data);
      setAiInterviewerActive(true);
      setInterviewMode("ai");
      setIsManualMode(false);
      
      if (!isResumeUploaded) {
        addMessage("⚠️ Resume not uploaded. Please upload your resume first for AI interview.", 'system', new Date().toISOString());
        alert("Please upload your resume first before starting AI interview!");
        return;
      }
      
      if (data.questions && data.questions.length > 0) {
        console.log('📝 Setting first question from WebRTC:', data.questions[0]);
        setCurrentQuestion(data.questions[0]);
        setQuestionHistory([data.questions[0]]);
        addMessage(data.questions[0], 'ai_interviewer', new Date().toISOString());
        
        if (voiceEnabled && 'speechSynthesis' in window) {
          speakQuestion(data.questions[0]);
        }
      }
      
      addMessage("🤖 AI Interviewer has been started by interviewer", 'system', new Date().toISOString());
      
    } else if (data.type === 'ai_interviewer_stop') {
      console.log('🤖 AI Interviewer stopping via WebRTC');
      setAiInterviewerActive(false);
      setInterviewMode("manual");
      setIsManualMode(true);
      setAiInterviewerStatus("idle");
      setCurrentQuestion("");
      setQuestionHistory([]);
      setResponseAnalysis(null);
      setIsResponding(false);
      setIsListeningForResponse(false);
      addMessage("🤖 AI Interviewer has been stopped. Manual mode activated.", 'system', new Date().toISOString());
      
      if (aiWsRef.current) {
        if (aiWsRef.current.pingInterval) clearInterval(aiWsRef.current.pingInterval);
        if (aiWsRef.current.pongTimeout) clearTimeout(aiWsRef.current.pongTimeout);
        aiWsRef.current.close();
      }
      
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    } else if (data.type === 'interview_mode_update') {
      console.log('🔄 Interview mode updated:', data.mode);
      setInterviewMode(data.mode);
      setIsManualMode(data.mode === "manual");
      
      if (data.mode === "ai" && !aiInterviewerActive) {
        addMessage("🤖 Interviewer switched to AI mode. AI Interviewer will start soon.", 'system', new Date().toISOString());
        
        if (!isResumeUploaded) {
          addMessage("⚠️ Please upload your resume to enable AI interview.", 'system', new Date().toISOString());
        }
      } else if (data.mode === "manual" && aiInterviewerActive) {
        setAiInterviewerActive(false);
        setIsResponding(false);
        setCurrentQuestion("");
        setQuestionHistory([]);
        addMessage("👨‍💼 Interviewer switched to manual mode.", 'system', new Date().toISOString());
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
      }
    }
  };

  // Function to speak the question
  const speakQuestion = (text) => {
    if (!voiceEnabled || !text) return;
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.lang = 'en-US';
      
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        const preferredVoice = voices.find(voice => 
          voice.lang.includes('en') && !voice.name.includes('Microsoft')
        );
        if (preferredVoice) {
          utterance.voice = preferredVoice;
        }
      }
      
      utterance.onstart = () => {
        console.log('🗣️ TTS started');
        setAiInterviewerStatus("speaking");
        setIsListeningForResponse(false);
      };
      
      utterance.onend = () => {
        console.log('🗣️ TTS finished');
        setAiInterviewerStatus("listening");
        setIsListeningForResponse(true);
        addMessage("👂 AI is waiting for your response...", 'system', new Date().toISOString());
      };
      
      utterance.onerror = (event) => {
        console.error('TTS error:', event);
        setAiInterviewerStatus("listening");
        setIsListeningForResponse(true);
      };
      
      window.speechSynthesis.speak(utterance);
      console.log('🗣️ Playing TTS for AI question');
    } else {
      setAiInterviewerStatus("listening");
      setIsListeningForResponse(true);
      addMessage("👂 AI is waiting for your response. Please type your answer.", 'system', new Date().toISOString());
    }
  };

  const initializeSpeechRecognition = () => {
    if (!voiceEnabled) return;
    
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognitionInstance = new SpeechRecognition();
      recognitionInstance.continuous = false;
      recognitionInstance.interimResults = true;
      recognitionInstance.lang = 'en-US';
      recognitionInstance.maxAlternatives = 1;
      
      recognitionInstance.onresult = (event) => {
        let finalTranscript = '';
        
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          }
        }
        
        if (finalTranscript) {
          console.log('🎤 Speech recognized:', finalTranscript);
          handleVoiceTranscript(finalTranscript);
          recognitionInstance.stop();
        }
      };
      
      recognitionInstance.onerror = (event) => {
        console.error('🎤 Speech recognition error:', event.error);
      };
      
      setRecognition(recognitionInstance);
    } else {
      console.warn('🎤 Speech recognition not supported in this browser');
      addMessage("⚠️ Voice input not fully supported. Please use the record button or type your responses.", 'system', new Date().toISOString());
    }
  };

  const startListeningForResponse = () => {
    if (aiInterviewerStatus !== "listening") {
      console.log('Not listening because status is:', aiInterviewerStatus);
      return;
    }
    
    if (recognition) {
      try {
        recognition.start();
        setIsListeningForResponse(true);
        
        const timeout = setTimeout(() => {
          if (recognition) {
            recognition.stop();
          }
          setIsListeningForResponse(false);
          console.log('⏰ Response timeout reached');
          addMessage("⏰ Response timeout. Please use the record button or type your response.", 'system', new Date().toISOString());
        }, 45000);
        
        setResponseTimeout(timeout);
        
      } catch (error) {
        console.error('🎤 Error starting speech recognition:', error);
      }
    }
  };

  const initializeWebRTCManager = () => {
    const user = JSON.parse(localStorage.getItem('interviewUser') || '{}');
    const userId = user?.id || 'participant-' + Date.now();
    
    if (webrtcManagerRef.current) {
      console.log('⚠️ WebRTC manager already exists, reinitializing...');
      webrtcManagerRef.current.isClosed = true;
      webrtcManagerRef.current.close();
    }
    
    webrtcManagerRef.current = createDefaultWebRTCManager(
      room.id, 
      userId, 
      'participant',
      {
        onConnectionStateChange: (state) => {
          console.log('🔗 Participant WebRTC connection state:', state);
          if (state === 'connected') {
            updateConnectionStatus("connected");
            setChatOnline(true);
            setIsConnecting(false);
            setSignalingConnected(true);
            console.log('✅ WebRTC connected with interviewer!');
            addMessage("✅ Connected to interviewer", 'system', new Date().toISOString());
            
            if (isManualMode) {
              addMessage("👋 Connected to interviewer. Ready for your interview.", 'system', new Date().toISOString());
            }
            
            if (aiInterviewerActive && !isExplicitlyClosing) {
              setTimeout(() => {
                connectToAIInterviewer();
              }, 1000);
            }
          } else if (state === 'connecting') {
            updateConnectionStatus("connecting");
            setIsConnecting(true);
          } else if (state === 'disconnected' || state === 'failed') {
            updateConnectionStatus("disconnected");
            setIsConnecting(false);
            setChatOnline(false);
            setSignalingConnected(false);
            addMessage("🔌 Disconnected from interviewer", 'system', new Date().toISOString());
          }
        },

        onIceConnectionStateChange: (state) => {
          console.log('🧊 Participant ICE connection state:', state);
        },

        onTrack: (event) => {
          console.log('🎥 Participant received remote track from interviewer:', event.track.kind, event.streams);
          
          if (event.streams && event.streams.length > 0) {
            const remoteStream = event.streams[0];
            console.log('🔗 Setting interviewer stream:', remoteStream.id);
            setInterviewerStream(remoteStream);
            setInterviewerConnected(true);
            
            const setupVideo = () => {
              if (interviewerVideoRef.current && remoteStream) {
                interviewerVideoRef.current.srcObject = remoteStream;
                interviewerVideoRef.current.play().catch(error => {
                  console.warn('⚠️ Failed to play interviewer video, retrying...', error);
                  setTimeout(setupVideo, 500);
                });
              }
            };
            setTimeout(setupVideo, 100);
          }
        },

        onMessage: (data) => {
          console.log('📨 Participant received message:', data.type);
          handleWebRTCMessage(data);
        },

        onInterviewerJoined: (data) => {
          console.log('🎯 Interviewer joined the room:', data.interviewerId);
          setInterviewerConnected(true);
          addMessage("👤 Interviewer has joined the room", 'system', new Date().toISOString());
          
          if (isManualMode) {
            addMessage("👨‍💼 Manual interview mode activated. The interviewer will guide you through the process.", 'system', new Date().toISOString());
          }
        },

        onPeerDisconnected: (data) => {
          console.log('👋 Peer disconnected:', data.role);
          if (data.role === 'interviewer') {
            setInterviewerConnected(false);
            setInterviewerStream(null);
            setIsInterviewerScreenSharing(false);
            updateConnectionStatus("disconnected");
            setChatOnline(false);
            setAiInterviewerActive(false);
            setAiInterviewerStatus("idle");
            setCurrentQuestion("");
            setQuestionHistory([]);
            setResponseAnalysis(null);
            setIsResponding(false);
            setIsListeningForResponse(false);
            addMessage("👋 Interviewer has left the room", 'system', new Date().toISOString());
            
            if ('speechSynthesis' in window) {
              window.speechSynthesis.cancel();
            }
          }
        },

        onOpen: () => {
          console.log('✅ Participant signaling connected');
          setSignalingConnected(true);
        },

        onClose: () => {
          console.log('🔌 Participant signaling closed');
          setSignalingConnected(false);
          setChatOnline(false);
        },

        onError: (error) => {
          console.error('❌ Participant WebRTC error:', error);
          updateConnectionStatus("error");
          setIsConnecting(false);
          addMessage("❌ Connection error occurred", 'system', new Date().toISOString());
        }
      }
    );
  };

  const connectWebSocket = () => {
    if (isExplicitlyClosing) return;
    
    if (wsRef.current) {
      try {
        if (wsRef.current.pingInterval) clearInterval(wsRef.current.pingInterval);
        if (wsRef.current.pongTimeout) clearTimeout(wsRef.current.pongTimeout);
        wsRef.current.close();
      } catch (e) {
        console.warn('Error closing existing WebSocket:', e);
      }
    }
    
    try {
      const ws = new WebSocket("ws://localhost:8001/ws");
      let pingInterval = null;
      let pongTimeout = null;
      let connectionTimeout = null;
      
      connectionTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          console.warn("⚠️ WebSocket connection timeout");
          ws.close();
        }
      }, 10000);
      
      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        console.log("✅ Participant WebSocket connected to AI backend");
        setAiConnected(true);
        reconnectAttemptsRef.current = 0;
        setConnectionRetryCount(0);
        
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            console.log("📡 Sending ping to AI server");
            ws.send(JSON.stringify({ 
              type: 'ping', 
              timestamp: Date.now(),
              id: Date.now()
            }));
            
            if (pongTimeout) clearTimeout(pongTimeout);
            pongTimeout = setTimeout(() => {
              console.warn("⚠️ No pong from AI server, reconnecting...");
              if (ws.readyState === WebSocket.OPEN) {
                ws.close();
              }
            }, 10000);
          }
        }, 25000);
        
        if (currentSessionId) {
          console.log('📝 Registering session with AI backend:', currentSessionId);
          ws.send(JSON.stringify({
            type: 'register_session',
            session_id: currentSessionId,
            room_id: room.id
          }));
        } else {
          console.warn('⚠️ No session ID available for registration');
        }
        
        addMessage("🤖 AI analysis system connected", 'system', new Date().toISOString());
        
        if (isCameraOn && mediaStream && !isExplicitlyClosing) {
          if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
          frameIntervalRef.current = setInterval(captureAndSendFrame, 500);
          console.log('🤖 AI frame capture started (500ms interval)');
        }
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'ping') {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'pong', 
                timestamp: Date.now(),
                id: data.id || Date.now()
              }));
            }
            return;
          }
          
          if (data.type === 'pong') {
            if (pongTimeout) {
              clearTimeout(pongTimeout);
              pongTimeout = null;
            }
            console.log('📡 Received pong from server');
            return;
          }
          
          if (data.type === 'fraud_alert') {
            console.log('⚠️ Fraud alert:', data.message);
            addMessage(`⚠️ Alert: ${data.message}`, 'system', new Date().toISOString());
          } else if (data.type === 'command_response') {
            console.log('✅ Command response:', data);
          } else if (data.type === 'ai_interview_started') {
            console.log('🤖 AI interview started:', data);
            setAiInterviewerActive(true);
            setAiInterviewerStatus("speaking");
            addMessage("🎬 AI Interview Started", 'system', new Date().toISOString());
            
            if (data.questions && data.questions.length > 0) {
              console.log('📝 Setting first question:', data.questions[0]);
              setCurrentQuestion(data.questions[0]);
              addMessage(data.questions[0], 'ai_interviewer', new Date().toISOString());
              speakQuestion(data.questions[0]);
              setQuestionHistory([data.questions[0]]);
            }
          } else if (data.type === 'ai_answer_feedback') {
            console.log('🤖 AI answer feedback received:', data);
            setAiInterviewerStatus("analyzing");
            setIsListeningForResponse(false);

            if (data.score !== undefined) {
              const feedbackMessage = `📊 Score: ${data.score}/10 - ${data.feedback || 'Good response!'}`;
              setResponseAnalysis({ score: data.score, feedback: data.feedback });
              addMessage(feedbackMessage, 'system', new Date().toISOString());
            }

            if (data.next_question) {
              console.log('📝 Next question received:', data.next_question);
              setAiInterviewerStatus("speaking");
              setIsListeningForResponse(false);
              setTimeout(() => {
                setCurrentQuestion(data.next_question);
                addMessage(data.next_question, 'ai_interviewer', new Date().toISOString());
                speakQuestion(data.next_question);
                setQuestionHistory(prev => [...prev, data.next_question]);
              }, 2000);
            } else if (data.final_results) {
              console.log('🎉 Final results received:', data.final_results);
              setAiInterviewerStatus("complete");
              setIsListeningForResponse(false);
              const finalMessage = `🎉 AI Interview Completed! Final Score: ${data.final_results.percentage}% - ${data.final_results.verdict}`;
              addMessage(finalMessage, 'system', new Date().toISOString());
              
              setTimeout(() => {
                setAiInterviewerActive(false);
                setAiInterviewerStatus("idle");
                setCurrentQuestion("");
                setQuestionHistory([]);
              }, 8000);
            }
          } else if (data.type === 'new_question') {
            console.log('📝 New question from AI:', data.question);
            setCurrentQuestion(data.question);
            addMessage(data.question, 'ai_interviewer', new Date().toISOString());
            speakQuestion(data.question);
            setQuestionHistory(prev => [...prev, data.question]);
          } else if (data.type === 'ai_interview_error') {
            console.error('❌ AI Interview Error:', data.message);
            setAiInterviewerStatus("error");
            setIsResponding(false);
            setIsListeningForResponse(false);
            addMessage(`❌ AI Error: ${data.message}`, 'system', new Date().toISOString());
          } else {
            const enhancedData = {
              faces: data.faces || 0,
              eye_moves: data.eye_moves || 0,
              face_alert: data.face_alert || "",
              gender: data.gender || "Unknown",
              mood: data.mood || "neutral",
              bg_voice: data.bg_voice || false,
              lipsync: data.lipsync || false,
              verification: data.verification || "Not set",
              speech: data.speech || false,
              mouth_ratio: data.mouth_ratio || 0,
              interview_active: data.interview_active || false
            };
            
            if (currentSessionId && enhancedData.faces > 0) {
              saveDetectionData(enhancedData);
            }
            
            if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat') && !webrtcManagerRef.current.isClosed) {
              const aiData = {
                type: 'ai_results',
                data: enhancedData,
                timestamp: new Date().toISOString()
              };
              webrtcManagerRef.current.sendData('chat', aiData);
            }
          }
        } catch (err) {
          console.error("❌ Error parsing WebSocket message:", err);
        }
      };
      
      ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        if (pingInterval) clearInterval(pingInterval);
        if (pongTimeout) clearTimeout(pongTimeout);
        
        console.log(`🔌 Participant WebSocket disconnected: code=${event.code}, reason=${event.reason}`);
        setAiConnected(false);
        
        if (frameIntervalRef.current) {
          clearInterval(frameIntervalRef.current);
          frameIntervalRef.current = null;
        }
        
        if (isCameraOn && !isExplicitlyClosing && reconnectAttemptsRef.current < maxReconnectAttempts) {
          const delay = Math.min(reconnectDelay * Math.pow(1.5, reconnectAttemptsRef.current), 30000);
          console.log(`🔄 Reconnecting WebSocket in ${delay}ms... (attempt ${reconnectAttemptsRef.current + 1}/${maxReconnectAttempts})`);
          
          setTimeout(() => {
            if (!isExplicitlyClosing) {
              reconnectAttemptsRef.current++;
              connectWebSocket();
            }
          }, delay);
        } else if (reconnectAttemptsRef.current >= maxReconnectAttempts) {
          console.error('❌ Max WebSocket reconnection attempts reached');
          addMessage("❌ AI analysis connection lost. Please refresh the page.", 'system', new Date().toISOString());
        }
      };
      
      ws.onerror = (error) => {
        clearTimeout(connectionTimeout);
        console.error("❌ Participant WebSocket error:", error);
        setAiConnected(false);
        
        if (!isExplicitlyClosing) {
          addMessage("⚠️ AI analysis connection issue. Reconnecting...", 'system', new Date().toISOString());
        }
      };

      wsRef.current = ws;
      wsRef.current.pingInterval = pingInterval;
      wsRef.current.pongTimeout = pongTimeout;
      
    } catch (err) {
      console.error("❌ Participant WebSocket connection failed:", err);
      setAiConnected(false);
      
      if (!isExplicitlyClosing && reconnectAttemptsRef.current < maxReconnectAttempts) {
        setTimeout(() => connectWebSocket(), reconnectDelay);
      }
    }
  };

  const captureAndSendFrame = useCallback(() => {
    if (!videoRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    
    if (isExplicitlyClosing) return;

    try {
      const video = videoRef.current;
      if (video.videoWidth === 0 || video.videoHeight === 0 || video.readyState !== 4) {
        if (Math.random() < 0.01) {
          console.log('🎥 Video not ready:', { 
            width: video.videoWidth, 
            height: video.videoHeight, 
            readyState: video.readyState 
          });
        }
        return;
      }
      
      if (!canvasRef.current) canvasRef.current = document.createElement('canvas');
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      const imageData = canvas.toDataURL('image/jpeg', 0.5);
      
      if (wsRef.current.readyState === WebSocket.OPEN && currentSessionId) {
        const frameData = {
          type: 'participant_frame',
          image: imageData,
          timestamp: Date.now(),
          roomId: room.id,
          userId: JSON.parse(localStorage.getItem('interviewUser') || '{}')?.id || 'participant',
          sessionId: currentSessionId
        };
        wsRef.current.send(JSON.stringify(frameData));
        
        setFrameCount(prev => prev + 1);
        
        if (frameCount % 50 === 0) {
          console.log('🎥 Frame sent for detection at', new Date().toLocaleTimeString(), 'Session:', currentSessionId);
        }
      }
    } catch (error) {
      console.error('❌ Error capturing participant frame:', error);
      canvasRef.current = null;
    }
  }, [videoRef, wsRef, isExplicitlyClosing, room.id, currentSessionId, frameCount]);

  useEffect(() => {
    if (isCameraOn && mediaStream && aiConnected && !isExplicitlyClosing && currentSessionId) {
      console.log('🎥 Setting up video frame capture for detection (500ms interval)');
      
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
      }
      
      frameIntervalRef.current = setInterval(() => {
        captureAndSendFrame();
      }, 500);
      
      return () => {
        if (frameIntervalRef.current) {
          clearInterval(frameIntervalRef.current);
          frameIntervalRef.current = null;
        }
      };
    }
  }, [isCameraOn, mediaStream, aiConnected, captureAndSendFrame, currentSessionId]);

  const checkConnectionHealth = useCallback(() => {
    if (!webrtcManagerRef.current || webrtcManagerRef.current.isClosed) return 'closed';
    
    const status = webrtcManagerRef.current.getStatus?.();
    console.log('🔍 Connection health check:', status);
    
    if (status && status.signaling === 'connected' && 
        status.peerConnection === 'failed' && 
        isCameraOn && interviewerConnected &&
        !webrtcManagerRef.current.isReconnecting && !isExplicitlyClosing) {
      console.log('🔄 Restarting ICE due to failed connection...');
      webrtcManagerRef.current.restartIce().catch(console.error);
    }
    
    return status?.peerConnection || 'disconnected';
  }, [isCameraOn, interviewerConnected]);

  const startCamera = async () => {
    try {
      console.log('🎥 Starting camera...');
      setIsConnecting(true);
      setIsExplicitlyClosing(false);
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { 
          width: { ideal: 1280 }, 
          height: { ideal: 720 }, 
          facingMode: "user", 
          frameRate: { ideal: 30, max: 60 } 
        },
        audio: { 
          echoCancellation: true, 
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      console.log('✅ Camera stream obtained');
      setMediaStream(stream);
      
      if (videoRef.current && !isScreenSharing) {
        videoRef.current.srcObject = stream;
        videoRef.current.classList.add('mirror-effect');
        videoRef.current.onloadedmetadata = () => {
          console.log('✅ Participant video ready');
          videoRef.current.play().catch(err => console.warn('⚠️ Video play warning:', err));
        };
      }
      
      setIsCameraOn(true);
      setIsMicOn(true);
      setHasJoined(true);
      
      initializeWebRTCManager();
      
      if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed) {
        console.log('🔗 Connecting to signaling server...');
        await webrtcManagerRef.current.connect();
        
        console.log('🎥 Setting local stream...');
        await webrtcManagerRef.current.setLocalStream(stream);
        
        console.log('✅ WebRTC setup complete, waiting for interviewer...');
      } else {
        console.error('❌ WebRTC manager not initialized');
      }
      
      const sessionId = await createSession();
      if (sessionId) {
        console.log('✅ Session created:', sessionId);
        connectWebSocket();
      } else {
        console.error('❌ Failed to create session');
      }
      
      initializeSpeechRecognition();
      
      console.log('✅ Camera started successfully');
      setIsConnecting(false);
      
      addMessage("🎥 Camera started. You can now upload your resume for personalized AI interview questions.", 'system', new Date().toISOString());
      
    } catch (err) {
      console.error("❌ Error accessing media devices:", err);
      alert("Could not access camera. Please check permissions.");
      setIsConnecting(false);
      setIsCameraOn(false);
    }
  };

  const stopCamera = () => {
    console.log('🛑 Stopping camera...');
    setIsExplicitlyClosing(true);
    
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }

    if (responseTimeout) {
      clearTimeout(responseTimeout);
    }

    if (connectionMonitorRef.current) {
      clearInterval(connectionMonitorRef.current);
      connectionMonitorRef.current = null;
    }
    
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      if (wsRef.current.pingInterval) clearInterval(wsRef.current.pingInterval);
      if (wsRef.current.pongTimeout) clearTimeout(wsRef.current.pongTimeout);
      wsRef.current.close();
      setAiConnected(false);
    }

    if (aiWsRef.current) {
      if (aiWsRef.current.pingInterval) clearInterval(aiWsRef.current.pingInterval);
      if (aiWsRef.current.pongTimeout) clearTimeout(aiWsRef.current.pongTimeout);
      aiWsRef.current.close();
      setAiInterviewerActive(false);
      setAiInterviewerStatus("idle");
      setCurrentQuestion("");
      setQuestionHistory([]);
      setResponseAnalysis(null);
      setIsResponding(false);
      setIsListeningForResponse(false);
    }

    if (webrtcManagerRef.current) {
      webrtcManagerRef.current.isClosed = true;
      webrtcManagerRef.current.close();
      webrtcManagerRef.current = null;
    }

    if (mediaStream) {
      mediaStream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      setMediaStream(null);
    }
    
    if (screenStream) {
      screenStream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      setScreenStream(null);
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (interviewerVideoRef.current) {
      interviewerVideoRef.current.srcObject = null;
    }
    
    setIsCameraOn(false);
    setIsMicOn(false);
    setIsScreenSharing(false);
    setChatOnline(false);
    setInterviewerStream(null);
    setIsInterviewerScreenSharing(false);
    setIsConnecting(false);
    setHasJoined(false);
    setInterviewerConnected(false);
    setSignalingConnected(false);
    setAiInterviewerActive(false);
    setAiInterviewerStatus("idle");
    setCurrentQuestion("");
    setResponseText("");
    setIsListeningForResponse(false);
    setQuestionHistory([]);
    setResponseAnalysis(null);
    setIsResponding(false);
    setConnectionRetryCount(0);
    reconnectAttemptsRef.current = 0;
    setIsExplicitlyClosing(false);
    
    updateConnectionStatus("disconnected");
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    
    console.log('✅ Camera stopped');
  };

  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        console.log('🖥️ Starting screen share...');
        
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { 
            cursor: "always", 
            displaySurface: "window", 
            width: { ideal: 1920 }, 
            height: { ideal: 1080 },
            frameRate: { ideal: 30, max: 60 }
          },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            sampleRate: 48000,
            channelCount: 2
          }
        });

        console.log('Screen stream obtained with tracks:', 
          screenStream.getVideoTracks().length, 'video,',
          screenStream.getAudioTracks().length, 'audio'
        );

        setScreenStream(screenStream);
        
        if (videoRef.current) {
          videoRef.current.srcObject = screenStream;
          videoRef.current.classList.remove('mirror-effect');
          videoRef.current.play().catch(err => console.warn('⚠️ Screen share play warning:', err));
        }
        
        setIsScreenSharing(true);
        
        if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed) {
          const videoTrack = screenStream.getVideoTracks()[0];
          if (videoTrack) {
            await webrtcManagerRef.current.replaceVideoTrack(videoTrack);
          }
          
          const audioTrack = screenStream.getAudioTracks()[0];
          if (audioTrack) {
            await webrtcManagerRef.current.replaceAudioTrack(audioTrack);
          }
          
          webrtcManagerRef.current.sendScreenShareState(true);
        }
        
        screenStream.getVideoTracks()[0].onended = () => {
          console.log('Screen share track ended by user');
          stopScreenShare();
        };
        
        console.log('✅ Screen sharing started');
        addMessage("🖥️ Started screen sharing", 'system', new Date().toISOString());
      } catch (err) {
        console.error("❌ Error sharing screen:", err);
        if (err.name !== 'NotAllowedError') {
          setIsScreenSharing(false);
          alert("Failed to share screen: " + err.message);
        }
      }
    } else {
      stopScreenShare();
    }
  };

  const stopScreenShare = () => {
    console.log('🛑 Stopping screen share...');
    
    if (screenStream) {
      screenStream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      setScreenStream(null);
    }
    
    if (videoRef.current && mediaStream) {
      videoRef.current.srcObject = mediaStream;
      videoRef.current.classList.add('mirror-effect');
      videoRef.current.play().catch(console.warn);
    }
    
    setIsScreenSharing(false);
    
    if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed && mediaStream) {
      const videoTrack = mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        webrtcManagerRef.current.replaceVideoTrack(videoTrack);
      }
      
      const audioTrack = mediaStream.getAudioTracks()[0];
      if (audioTrack) {
        webrtcManagerRef.current.replaceAudioTrack(audioTrack);
      }
      
      webrtcManagerRef.current.sendScreenShareState(false);
    }
    
    console.log('✅ Screen share stopped');
    addMessage("🛑 Stopped screen sharing", 'system', new Date().toISOString());
  };

  const isParticipantVideoReady = () => {
    if (!videoRef.current) return false;
    const video = videoRef.current;
    return video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
  };

  const createSession = async () => {
    try {
      const user = JSON.parse(localStorage.getItem('interviewUser') || '{}');
      const sessionId = `session-${room.id}-participant-${Date.now()}`;
      
      const response = await fetch(`${NODE_API_URL}/detections/session/start`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          roomId: room.id,
          userId: user.id || 'participant',
          userType: 'participant',
          interviewMode: interviewMode,
          voiceEnabled: voiceEnabled
        })
      });
      
      const result = await response.json();
      if (result.success) {
        console.log('✅ Participant session created:', sessionId);
        setCurrentSessionId(sessionId);
        return sessionId;
      } else {
        console.error('❌ Failed to create participant session:', result.message);
        return null;
      }
    } catch (error) {
      console.error('❌ Error creating participant session:', error);
      return null;
    }
  };

  const saveDetectionData = async (detectionData) => {
    try {
      if (!currentSessionId) {
        console.error('❌ No active session for saving detection');
        return;
      }

      await fetch(`${NODE_API_URL}/detections/save`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          roomId: room.id,
          userId: JSON.parse(localStorage.getItem('interviewUser') || '{}')?.id || 'participant',
          timestamp: new Date(),
          ...detectionData
        })
      });
    } catch (error) {
      console.error('❌ Error saving participant detection:', error);
    }
  };

  const toggleChat = () => {
    setShowChat(!showChat);
    if (!showChat) setUnreadMessages(0);
  };

  const addMessage = (text, sender, timestamp, id = null) => {
    const messageId = id || Date.now() + Math.random();
    const message = {
      id: messageId,
      text,
      sender,
      timestamp: timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString()
    };
    
    setMessages(prev => {
      const exists = prev.some(msg => msg.id === messageId);
      if (!exists) {
        return [...prev, message];
      }
      return prev;
    });
    
    if (sender === 'interviewer' || sender === 'ai_interviewer') {
      if (!showChat) setUnreadMessages(prev => prev + 1);
      
      if (sender === 'ai_interviewer') {
        console.log('📝 Adding AI interviewer message to chat:', text.substring(0, 50));
      }
    }
  };

  const sendMessage = () => {
    if (newMessage.trim() === "") return;
    const timestamp = new Date().toISOString();
    const messageText = newMessage.trim();
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    addMessage(messageText, 'participant', timestamp, messageId);
    setUnreadMessages(0);

    if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed) {
      const success = webrtcManagerRef.current.sendChatMessage(messageText, messageId);
      if (!success) {
        console.warn('⚠️ Failed to send message via WebRTC, will retry...');
        setTimeout(() => {
          if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed) {
            webrtcManagerRef.current.sendChatMessage(messageText, messageId);
          }
        }, 500);
      }
    }

    setNewMessage("");
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') sendMessage();
  };

  const toggleCamera = () => {
    if (isCameraOn) stopCamera();
    else startCamera();
  };

  const toggleMic = () => {
    if (!mediaStream) {
      alert("Please turn on your camera first to enable microphone");
      return;
    }
    
    const currentStream = isScreenSharing ? screenStream : mediaStream;
    if (currentStream) {
      const audioTrack = currentStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMicOn(audioTrack.enabled);
        console.log(`🎤 Microphone ${audioTrack.enabled ? 'unmuted' : 'muted'}`);
        addMessage(`🎤 Microphone ${audioTrack.enabled ? 'unmuted' : 'muted'}`, 'system', new Date().toISOString());
      }
    }
  };

  const handleLeaveMeeting = async () => {
    console.log('🚪 Leaving meeting...');
    setIsExplicitlyClosing(true);
    
    if (voiceEnabled && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    
    stopCamera();
    
    if (currentSessionId) {
      try {
        await fetch(`${NODE_API_URL}/detections/session/end`, {
          method: "POST",
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: currentSessionId })
        });
        console.log('✅ Session ended in database');
      } catch (error) {
        console.error('❌ Error ending session:', error);
      }
    }
    
    onLeave();
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(room.id)
      .then(() => alert('✅ Room ID copied to clipboard!'))
      .catch(err => {
        console.error('Failed to copy room ID: ', err);
        alert('Failed to copy Room ID. Please copy it manually.');
      });
  };

  const checkConnection = useCallback(() => {
    if (isManualMode && isCameraOn && connectionStatus !== 'connected' && !isExplicitlyClosing) {
      console.log('🔄 Checking manual mode connection status...');
      
      if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed) {
        const status = webrtcManagerRef.current.getStatus?.();
        console.log('📊 Connection status:', status);
        
        if (status && status.peerConnection !== 'connected' && status.signaling === 'connected' &&
            !webrtcManagerRef.current.isReconnecting) {
          console.log('🔄 Attempting to establish WebRTC connection...');
          
          if (webrtcManagerRef.current.createOffer) {
            setTimeout(() => {
              if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed) {
                webrtcManagerRef.current.createOffer().catch(console.error);
              }
            }, 1000);
          }
        }
      }
    }
  }, [isManualMode, isCameraOn, connectionStatus]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.key === 'u' && !isResumeUploaded && !resumeProcessing && !isExplicitlyClosing) {
        e.preventDefault();
        fileInputRef.current?.click();
      }
      if (e.ctrlKey && e.key === 'v' && aiInterviewerActive) {
        e.preventDefault();
        toggleVoiceInput();
        addMessage(showVoiceInput ? "🔇 Voice input disabled" : "🎤 Voice input enabled", 'system', new Date().toISOString());
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isResumeUploaded, resumeProcessing, aiInterviewerActive, showVoiceInput]);

  useEffect(() => {
    if (aiInterviewerActive && interviewMode === "ai" && !currentQuestion && !isExplicitlyClosing) {
      console.log('❓ AI interview active but no question - requesting...');
      
      const timeout = setTimeout(() => {
        if (aiInterviewerActive && !currentQuestion && !isExplicitlyClosing) {
          requestAIQuestion();
          addMessage("🔄 Requesting AI question...", 'system', new Date().toISOString());
        }
      }, 3000);
      
      return () => clearTimeout(timeout);
    }
  }, [aiInterviewerActive, currentQuestion, interviewMode]);

  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (showChat) setUnreadMessages(0);
  }, [showChat]);

  useEffect(() => {
    if (interviewerStream && interviewerVideoRef.current && !isExplicitlyClosing) {
      console.log('🎬 Setting up interviewer video element with stream');
      interviewerVideoRef.current.srcObject = interviewerStream;
      
      const playVideo = () => {
        if (interviewerVideoRef.current) {
          interviewerVideoRef.current.play().catch(error => {
            console.warn('⚠️ Failed to play interviewer video, retrying...', error);
            setTimeout(playVideo, 500);
          });
        }
      };
      
      playVideo();
    }
  }, [interviewerStream]);

  useEffect(() => {
    if (interviewMode === "ai") {
      setInterviewerStream(null);
      if (interviewerVideoRef.current) {
        interviewerVideoRef.current.srcObject = null;
      }
    }
  }, [interviewMode]);

  useEffect(() => {
    if (isCameraOn && interviewerConnected && !isExplicitlyClosing) {
      connectionMonitorRef.current = setInterval(() => {
        checkConnectionHealth();
      }, 30000);
    }
    
    return () => {
      if (connectionMonitorRef.current) {
        clearInterval(connectionMonitorRef.current);
      }
    };
  }, [checkConnectionHealth, isCameraOn, interviewerConnected]);

  useEffect(() => {
    let intervalId;
    
    if (isManualMode && isCameraOn && !isExplicitlyClosing) {
      intervalId = setInterval(() => {
        checkConnection();
      }, 30000);
    }
    
    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [checkConnection, isManualMode, isCameraOn]);

  useEffect(() => {
    return () => {
      if (recognition) {
        recognition.stop();
      }
      clearTimeout(responseTimeout);
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  useEffect(() => {
    console.log('🎯 Participant room mounted');
    
    return () => {
      console.log('🧹 Cleaning up participant room...');
      setIsExplicitlyClosing(true);
      stopCamera();
    };
  }, []);

  return (
    <div className={`participant-room ${aiInterviewerActive ? 'ai-interview-active' : ''} ${isManualMode ? 'manual-mode' : ''}`}>
      <div className="room-header">
        <div className="header-left">
          <h2>True Hire</h2>
          <span className="room-status participant">CANDIDATE</span>
          <span className={`connection-status ${connectionStatus}`}>
            {connectionStatus === 'connected' ? '● Connected' : 
            connectionStatus === 'connecting' ? '● Connecting...' : '● Disconnected'}
          </span>
          {aiInterviewerActive && (
            <span className="ai-interviewer-badge">🤖 AI Interview Active</span>
          )}
          {isResumeUploaded && (
            <span className="resume-badge">📄 Resume Uploaded</span>
          )}
          {uploadError && !isResumeUploaded && (
            <span className="resume-error-badge">❌ Upload Failed</span>
          )}
          {voiceEnabled && aiInterviewerActive && (
            <span className="voice-badge">🎤 Voice Mode</span>
          )}
        </div>
        <div className="header-right">
          <ResumePreview 
            isResumeUploaded={isResumeUploaded}
            resumeFile={resumeFile}
            resumeText={resumeText}
            resumeProcessing={resumeProcessing}
            onViewResume={handleViewResume}
            onChangeResume={handleChangeResume}
          />
          
          <div className="room-id">
            <span>Room ID:</span>
            <span className="room-id-value">{room.id}</span>
          </div>
          <button className="copy-room-id-button" onClick={copyRoomId}>Copy Room ID</button>
          <button className="leave-button" onClick={handleLeaveMeeting}>Leave Meeting</button>
        </div>
      </div>

      <div className="room-content">
        <div className="video-section">
          <div className="video-container">
            <div className={`video-grid ${isScreenSharing || isInterviewerScreenSharing ? 'has-screen-share' : ''}`}>
              
              <div className={`video-tile interviewer-tile ${isInterviewerScreenSharing ? 'screen-share' : ''}`}>
                {interviewMode === "ai" ? (
                  <ParticipantAIInterviewQA
                    question={currentQuestion}
                    answer={responseText}
                    setAnswer={setResponseText}
                    disabled={aiInterviewerStatus !== "listening" || isResponding}
                    onSubmit={() => {
                      console.log('🎤 Submitting answer:', responseText);
                      handleCandidateResponse(responseText);
                    }}
                    isResponding={isResponding}
                    aiInterviewerStatus={aiInterviewerStatus}
                    currentQuestionNumber={questionHistory.length}
                    totalQuestions={10}
                    resumeUploaded={isResumeUploaded}
                    voiceEnabled={voiceEnabled}
                    showVoiceInput={showVoiceInput}
                    onVoiceTranscript={handleVoiceTranscript}
                  />
                ) : (
                  <>
                    <video
                      ref={interviewerVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className={`video-element ${isInterviewerScreenSharing ? 'screen-share' : ''}`}
                    />
                    {!interviewerStream && (
                      <div className="video-overlay">
                        <div className="camera-icon">👤</div>
                        <div>Interviewer will join shortly</div>
                      </div>
                    )}
                  </>
                )}
                
                <div className="video-info">
                  <div className="participant-name">
                    {interviewMode === "ai" ? (
                      <>
                        🤖 AI Interviewer
                        {voiceEnabled && <span className="voice-icon-small">🎤</span>}
                      </>
                    ) : 'Interviewer'}
                    {isInterviewerScreenSharing && ' - Screen Sharing'}
                  </div>
                  <div className="video-status">
                    {interviewMode === "ai" && (
                      <span className={`ai-status-badge ${aiInterviewerStatus}`}>
                        {aiInterviewerStatus === 'speaking' && ' 🗣️ Speaking'}
                        {aiInterviewerStatus === 'listening' && ' 👂 Listening'}
                        {aiInterviewerStatus === 'analyzing' && ' 🔍 Analyzing'}
                        {aiInterviewerStatus === 'idle' && ' 🤖 Ready'}
                        {aiInterviewerStatus === 'complete' && ' ✅ Complete'}
                        {aiInterviewerStatus === 'error' && ' ❌ Error'}
                      </span>
                    )}
                  </div>
                </div>
                
                {isInterviewerScreenSharing && interviewMode !== "ai" && (
                  <div className="screen-share-indicator">
                    <span>🖥️ Interviewer is sharing screen</span>
                  </div>
                )}
              </div>

              <div className={`video-tile participant-tile ${isScreenSharing ? 'screen-share' : ''}`}>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`video-element ${isScreenSharing ? 'screen-share' : 'mirror-effect'}`}
                />
                <div className="video-info">
                  <div className="participant-name">
                    You {isScreenSharing && ' - Screen Sharing'}
                    {isResumeUploaded && ' 📄'}
                    {interviewMode === "ai" && currentQuestion && ' 🎤 Responding to AI'}
                    {interviewMode === "manual" && ' (Manual Mode)'}
                    {voiceEnabled && aiInterviewerActive && ' 🎤 Voice Ready'}
                  </div>
                </div>
                {!isCameraOn && !isScreenSharing && (
                  <div className="video-overlay">
                    <div className="camera-icon">📹</div>
                    <div>Your camera is off</div>
                  </div>
                )}
                {isConnecting && (
                  <div className="video-overlay">
                    <div className="camera-icon">🔄</div>
                    <div>Connecting to interview...</div>
                  </div>
                )}
                {isScreenSharing && (
                  <div className="screen-share-indicator">
                    <span>🖥️ You are sharing your screen</span>
                  </div>
                )}
                {aiInterviewerStatus === 'listening' && voiceEnabled && (
                  <div className="listening-overlay">
                    <div className="listening-animation">
                      <span></span><span></span><span></span>
                    </div>
                    <span>Listening...</span>
                  </div>
                )}
              </div>
            </div>

            <div className="join-call-container">
              <button
                onClick={toggleCamera}
                disabled={isConnecting}
                className={`join-call-button ${isCameraOn ? 'leave' : 'join'} ${isConnecting ? 'connecting' : ''}`}
              >
                <span className="call-button-icon">
                  {isConnecting ? '🔄' : (isCameraOn ? '📹' : '🎥')}
                </span>
                <span className="call-button-text">
                  {isConnecting ? "Connecting..." : (isCameraOn ? "Leave Call" : "Join Call")}
                </span>
              </button>
            </div>

            <div className="bottom-controls">
              {interviewMode === "ai" && (
                <div className="ai-voice-indicator">
                  <div className={`ai-voice-dot ${aiInterviewerStatus === 'speaking' ? 'speaking' : 
                    aiInterviewerStatus === 'listening' ? 'listening' : 'idle'}`}></div>
                  <div className="ai-voice-status">
                    {aiInterviewerStatus === 'speaking' && 'AI Speaking'}
                    {aiInterviewerStatus === 'listening' && 'Listening to You'}
                    {aiInterviewerStatus === 'analyzing' && 'Analyzing Response'}
                    {aiInterviewerStatus === 'complete' && 'Interview Complete'}
                  </div>
                  {voiceEnabled && (
                    <button 
                      onClick={toggleVoiceInput}
                      className={`voice-toggle-button ${showVoiceInput ? 'active' : ''}`}
                      title={showVoiceInput ? "Disable voice input" : "Enable voice input"}
                    >
                      {showVoiceInput ? '🎤' : '🔇'}
                    </button>
                  )}
                </div>
              )}
              
              <button
                onClick={toggleMic}
                className={`control-button mic-button ${isMicOn ? 'active' : 'inactive'}`}
                title={isMicOn ? "Mute Microphone" : "Unmute Microphone"}
                disabled={!isCameraOn || isConnecting}
              >
                <span className="control-icon">{isMicOn ? "🎤" : "🔇"}</span>
              </button>
              <button
                onClick={toggleCamera}
                className={`control-button camera-button ${isCameraOn ? 'active' : 'inactive'}`}
                title={isCameraOn ? "Turn Off Camera" : "Turn On Camera"}
                disabled={isConnecting}
              >
                <span className="control-icon">{isCameraOn ? "📹" : "📷"}</span>
              </button>
              <button
                onClick={toggleScreenShare}
                className={`control-button share-button ${isScreenSharing ? 'active' : 'inactive'}`}
                title={isScreenSharing ? "Stop Screen Share" : "Share Screen"}
                disabled={!isCameraOn || isConnecting || aiInterviewerActive}
              >
                <span className="control-icon">{isScreenSharing ? "🖥️" : "📤"}</span>
              </button>
              <button
                onClick={toggleChat}
                className={`control-button chat-button ${showChat ? 'active' : 'inactive'}`}
                title={showChat ? "Close Chat" : "Open Chat"}
              >
                <span className="control-icon">💬</span>
                {unreadMessages > 0 && <span className="chat-notification-badge">{unreadMessages}</span>}
              </button>
              
              {!isResumeUploaded && (
                <button 
                  onClick={() => {
                    if (!isCameraOn) {
                      alert("Please turn on your camera first before uploading resume.\n\nYour face needs to be visible for AI interview preparation.");
                      toggleCamera();
                    } else if (!isParticipantVideoReady()) {
                      alert("Please ensure your face is clearly visible in the camera with good lighting before uploading resume.");
                    } else {
                      fileInputRef.current?.click();
                    }
                  }}
                  className="control-button resume-upload-button"
                  title="Upload Resume for AI Interview (Ctrl+U)"
                  disabled={resumeProcessing}
                >
                  <span className="control-icon">{resumeProcessing ? "⏳" : "📄"}</span>
                  <span className="resume-upload-text">
                    {resumeProcessing ? "Processing..." : "Upload Resume"}
                  </span>
                </button>
              )}
              
              {uploadSuccess && (
                <div className="upload-success-indicator" title="Resume uploaded successfully">
                  ✅
                </div>
              )}
            </div>
          </div>
        </div>

        {showChat && (
          <div className="chat-section">
            <div className="chat-container">
              <div className="chat-header">
                <h3>Chat {chatOnline ? '🟢' : '🔴'}</h3>
                <button className="close-chat" onClick={toggleChat}>×</button>
              </div>
              <div className="chat-messages" ref={chatMessagesRef}>
                {messages.length === 0 ? (
                  <div className="no-messages">
                    <p>No messages yet</p>
                    <span>Start a conversation</span>
                  </div>
                ) : (
                  messages.map(message => (
                    <div key={message.id} className={`message ${message.sender === 'participant' ? 'participant' : 
                      message.sender === 'ai_interviewer' ? 'ai_interviewer' : 
                      message.sender === 'system' ? 'system' : 'interviewer'}`}>
                      <div className="message-sender">
                        {message.sender === 'participant' ? 'You' : 
                         message.sender === 'ai_interviewer' ? 'AI Interviewer' : 
                         message.sender === 'system' ? 'System' : 'Interviewer'}
                      </div>
                      <div className="message-text">{message.text}</div>
                      <div className="message-time">{message.timestamp}</div>
                    </div>
                  ))
                )}
              </div>
              <div className="chat-input">
                <input
                  type="text"
                  placeholder={chatOnline ? "Type a message..." : "Connecting chat..."}
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={handleKeyPress}
                  className="message-input"
                  disabled={!chatOnline}
                />
                <button
                  onClick={sendMessage}
                  className="send-button"
                  disabled={!chatOnline || !newMessage.trim()}
                >
                  Send
                </button>
              </div>
              <div className="chat-status">
                <span className={`status-indicator ${chatOnline ? 'online' : 'offline'}`}>
                  {chatOnline ? '🟢 Chat Online' : '🔴 Chat Offline'}
                </span>
                {signalingConnected && <span className="signaling-status"> | Signaling Connected</span>}
                {aiInterviewerActive && <span className="ai-interview-status"> | AI Interview Active</span>}
                {aiConnected && <span className="ai-analysis-status"> | AI Analyzing</span>}
                {isResumeUploaded && <span className="resume-status"> | Resume Uploaded</span>}
                {!isResumeUploaded && <span className="resume-missing"> | Resume Required for AI</span>}
                {voiceEnabled && aiInterviewerActive && <span className="voice-status"> | 🎤 Voice Mode</span>}
              </div>
            </div>
          </div>
        )}
      </div>
      
      <input
        type="file"
        ref={fileInputRef}
        id="resume-file-input"
        accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />
    </div>
  );
}

export default ParticipantRoom;