import React, { useEffect, useState, useRef, useCallback } from "react";
import "./InterviewRoom.css";
import { createDefaultWebRTCManager } from "../utils/webrtc";
import ReportModal from "./ReportModal";
import AIInterviewerPanel from "./AIInterviewerPanel";
import { useInterviewerMode } from "./InterviewModeContext";

function InterviewRoom({ room, onLeave }) {
  const [aiResults, setAiResults] = useState({
    faces: 0,
    eye_moves: 0,
    face_alert: "",
    gender: "Unknown",
    mood: "neutral",
    bg_voice: false,
    lipsync: false,
    verification: "Not set",
    speech: false,
    mouth_ratio: 0,
    interview_active: false
  });

  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [interviewStatus, setInterviewStatus] = useState("not_started");
  const [mediaStream, setMediaStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [participantStream, setParticipantStream] = useState(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isMicOn, setIsMicOn] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isParticipantScreenSharing, setIsParticipantScreenSharing] = useState(false);
  const [activeParticipants, setActiveParticipants] = useState(0);
  const [showChat, setShowChat] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [referenceFaceSet, setReferenceFaceSet] = useState(false);
  const [capturingReference, setCapturingReference] = useState(false);
  const [chatConnected, setChatConnected] = useState(false);
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [aiConnected, setAiConnected] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [finalReport, setFinalReport] = useState(null);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [sessionStartTime, setSessionStartTime] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [signalingConnected, setSignalingConnected] = useState(false);
  
  // Enhanced AI Interviewer states
  const [aiInterviewerActive, setAiInterviewerActive] = useState(false);
  const [aiInterviewerStatus, setAiInterviewerStatus] = useState("idle");
  const [currentQuestion, setCurrentQuestion] = useState("");
  const [candidateResponse, setCandidateResponse] = useState("");
  const [questionHistory, setQuestionHistory] = useState([]);
  const [responseAnalysis, setResponseAnalysis] = useState(null);
  const [resumeData, setResumeData] = useState(null);
  const [showAIConfigModal, setShowAIConfigModal] = useState(false);
  const [aiInterviewerConfig, setAiInterviewerConfig] = useState({
    difficulty: "medium",
    duration: 30,
    questionTypes: ["technical", "behavioral", "resume_based"],
    enableFollowUps: true,
    enableVoiceQuestions: true
  });
  const [connectionRetryCount, setConnectionRetryCount] = useState(0);
  const [isExplicitlyClosing, setIsExplicitlyClosing] = useState(false);
  const [frameCount, setFrameCount] = useState(0);

  // ✅ USE INTERVIEWER MODE FROM CONTEXT
  const { 
    mode: interviewMode, 
    setMode: setInterviewMode, 
    syncModes, 
    syncStatus,
    breakSync
  } = useInterviewerMode();

  const videoRef = useRef(null);
  const participantVideoRef = useRef(null);
  const wsRef = useRef(null);
  const aiWsRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const canvasRef = useRef(null);
  const frameIntervalRef = useRef(null);
  const webrtcManagerRef = useRef(null);
  const ttsAudioRef = useRef(null);
  const modeSyncTimeoutRef = useRef(null);
  const connectionMonitorRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectAttempts = 5;

  const PYTHON_API_URL = 'http://localhost:8001';
  const NODE_API_URL = 'http://localhost:8000/api';

  // Enhanced connection status management
  const updateConnectionStatus = (status) => {
    console.log(`🔗 Interviewer connection status updating to: ${status}`);
    setConnectionStatus(status);
    
    if (status === 'connected') {
      setConnectionRetryCount(0);
      reconnectAttemptsRef.current = 0;
    }
  };

  const calculateDuration = () => {
    if (!sessionStartTime) return "00:00:00";
    const endTime = new Date();
    const diff = endTime - sessionStartTime;
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const calculatePerformanceScore = (detectionData) => {
    let score = 50;
    
    if (detectionData.faces === 1) score += 15;
    if (detectionData.eye_moves < 10) score += 10;
    if (detectionData.lipsync) score += 10;
    if (!detectionData.bg_voice) score += 5;
    if (detectionData.speech) score += 5;
    if (detectionData.mood === 'happy' || detectionData.mood === 'neutral') score += 5;
    
    if (detectionData.faces === 0) score -= 20;
    if (detectionData.faces > 1) score -= 15;
    if (detectionData.eye_moves > 30) score -= 10;
    if (detectionData.face_alert) score -= 10;
    if (detectionData.bg_voice) score -= 10;
    
    return Math.max(0, Math.min(100, score));
  };

  const handleWebSocketMessage = (data) => {
    console.log('📡 WebSocket message received:', data.type);
    
    if (data.type === 'ping') {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
      return;
    }
    
    if (data.type === 'pong') {
      console.log('📡 Received pong from server');
      return;
    }
    
    if (data.type === 'connection_established') {
      console.log('✅ WebSocket connection established');
      return;
    }
    
    if (data.type === 'command_response') {
      console.log('✅ Command response:', data);
      return;
    }
    
    if (data.faces !== undefined) {
      console.log('🎯 Detection data received:', {
        faces: data.faces,
        mood: data.mood,
        gender: data.gender,
        speech: data.speech
      });
      
      const enhancedData = {
        faces: data.faces || 0,
        eye_moves: data.eye_moves || 0,
        face_alert: data.face_alert || "",
        gender: data.gender || "Unknown",
        mood: data.mood || "neutral",
        bg_voice: data.bg_voice || false,
        lipsync: data.lipsync || false,
        verification: referenceFaceSet ? "Reference Set" : (data.verification || "Not set"),
        speech: data.speech || false,
        mouth_ratio: data.mouth_ratio || 0,
        interview_active: data.interview_active || false
      };
      
      setAiResults(prev => {
        const hasChanged = JSON.stringify(prev) !== JSON.stringify(enhancedData);
        if (hasChanged) {
          console.log('🔄 Updating AI results:', enhancedData);
          return enhancedData;
        }
        return prev;
      });
      
      if (currentSessionId && (enhancedData.faces > 0 || enhancedData.speech)) {
        saveDetectionData(enhancedData);
      }
    }
  };

  const handleWebRTCMessage = (data) => {
    console.log('📨 Received WebRTC message:', data.type);
    
    switch (data.type) {
      case 'chat':
        const messageExists = messages.some(msg => 
          msg.id === data.id || 
          (msg.text === data.message && msg.sender === data.sender && Math.abs(new Date(msg.timestamp) - new Date(data.timestamp)) < 1000)
        );
        
        if (!messageExists) {
          addMessage(data.message, data.sender, data.timestamp, data.id);
        }
        break;
        
      case 'screen_share_state':
        setIsParticipantScreenSharing(data.isSharing);
        break;
        
      case 'ai_results':
        console.log('🤖 AI results from participant:', data.data);
        if (data.data) {
          setAiResults(prev => ({
            ...prev,
            faces: data.data.faces || prev.faces,
            mood: data.data.mood || prev.mood,
            gender: data.data.gender || prev.gender,
            speech: data.data.speech || prev.speech
          }));
        }
        break;
        
      case 'data_channel_state':
        if (data.channel === 'chat' && data.state === 'open') {
          setChatConnected(true);
        } else if (data.channel === 'chat' && data.state === 'closed') {
          setChatConnected(false);
        }
        break;
        
      case 'resume_uploaded':
        console.log('📄 Resume uploaded notification from participant:', data);
        
        const newResumeData = {
          text: data.resume_text,
          originalFile: data.original_file || null,
          fileType: data.file_type || null,
          fileExtension: data.file_extension || null,
          uploadedAt: new Date().toISOString(),
          filename: data.filename,
          roomId: data.room_id || room.id,
          manualMode: data.manual_mode || false
        };
        setResumeData(newResumeData);
        
        addMessage(`📄 Participant uploaded resume: ${data.filename || 'resume.txt'}`, 'system', new Date().toISOString());
        
        if (data.resume_text && data.room_id) {
          console.log('📤 Syncing resume to Python backend...');
          
          const formData = new FormData();
          formData.append('session_id', currentSessionId || `manual-${Date.now()}`);
          formData.append('room_id', data.room_id || room.id);
          formData.append('resume_text', data.resume_text || 'Resume uploaded by participant');
          
          fetch(`${PYTHON_API_URL}/upload_resume`, {
            method: "POST",
            body: formData,
          })
          .then(response => response.json())
          .then(result => {
            console.log('✅ Resume synced to Python backend:', result);
            addMessage("✅ Resume synchronized with AI system", 'system', new Date().toISOString());
            
            if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
              webrtcManagerRef.current.sendData('chat', {
                type: 'resume_sync_complete',
                message: 'Resume ready for AI interview',
                room_id: data.room_id || room.id,
                session_id: currentSessionId,
                timestamp: new Date().toISOString()
              });
            }
          })
          .catch(err => {
            console.error('❌ Failed to sync resume to Python backend:', err);
            addMessage("⚠️ Failed to sync resume with AI system", 'system', new Date().toISOString());
          });
        }
        break;
        
      case 'participant_connected':
        setActiveParticipants(1);
        if (interviewMode === 'manual') {
          addMessage("✅ Participant connected. You can now start the interview.", 'system', new Date().toISOString());
        }
        break;
        
      case 'interview_mode_update':
        console.log('🔄 Mode update from participant:', data.mode, data.syncResponse);
        
        if (data.syncResponse === "accepted") {
          console.log('✅ Participant accepted mode sync');
          syncModes(data.mode);
          
          addMessage(
            `✅ Participant synchronized to ${data.mode === "ai" ? "AI" : "Manual"} mode.`, 
            'system', 
            new Date().toISOString()
          );
          
          if (modeSyncTimeoutRef.current) {
            clearTimeout(modeSyncTimeoutRef.current);
            modeSyncTimeoutRef.current = null;
          }
          
          handleModeTransition(data.mode);
          
        } else if (data.syncResponse === "rejected") {
          console.log('❌ Participant rejected mode sync');
          if (breakSync) breakSync();
          
          addMessage(
            `⚠️ Participant rejected mode sync. Modes are now independent.`, 
            'system', 
            new Date().toISOString()
          );
          
          if (modeSyncTimeoutRef.current) {
            clearTimeout(modeSyncTimeoutRef.current);
            modeSyncTimeoutRef.current = null;
          }
          
        } else if (data.syncRequest && data.source === 'participant') {
          console.log('📥 Participant requesting mode change to:', data.mode);
          handleParticipantModeRequest(data.mode, data.reason);
        }
        break;
        
      // ADD THIS CASE - Handle answer submissions from participant
      case 'answer_submission':
        console.log('📝 Received answer from participant via WebRTC:', {
          question: data.question?.substring(0, 50),
          answer: data.answer?.substring(0, 50),
          session_id: data.session_id
        });
        
        // Add to chat so interviewer can see it
        addMessage(data.answer, 'participant', data.timestamp || new Date().toISOString());
        addMessage("🤖 AI is analyzing response...", 'system', new Date().toISOString());
        
        // Forward the answer to Python backend
        const effectiveSessionId = data.session_id || currentSessionId;
        
        if (effectiveSessionId && (aiInterviewerActive || interviewMode === 'ai')) {
          console.log('📤 Submitting participant answer to Python backend...');
          
          // Ensure AI is marked as active if we're receiving answers in AI mode
          if (!aiInterviewerActive && interviewMode === 'ai') {
            setAiInterviewerActive(true);
          }
          
          fetch(`${PYTHON_API_URL}/submit_ai_answer`, {
            method: "POST",
            headers: { 
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              session_id: effectiveSessionId,
              question: data.question,
              answer: data.answer,
              room_id: room.id
            }),
            signal: AbortSignal.timeout(30000) // 30 second timeout
          })
          .then(async response => {
            if (!response.ok) {
              const errorText = await response.text();
              throw new Error(`HTTP ${response.status}: ${errorText}`);
            }
            return response.json();
          })
          .then(result => {
            console.log('✅ Answer processed by backend:', result);
            
            // Add to chat for visibility
            if (result.score !== undefined) {
              addMessage(`Participant score: ${result.score}/10`, 'system', new Date().toISOString());
            }
            
            // Forward result back to participant via WebRTC
            if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
              webrtcManagerRef.current.sendData('chat', {
                type: 'answer_result',
                score: result.score,
                feedback: result.feedback,
                next_question: result.next_question,
                is_complete: result.is_complete,
                final_results: result.final_results,
                session_id: effectiveSessionId,
                timestamp: new Date().toISOString()
              });
              console.log('📤 Sent answer result to participant via WebRTC');
            }
            
            // Update interviewer's local state
            if (result.next_question) {
              setCurrentQuestion(result.next_question);
              setQuestionHistory(prev => [...prev, result.next_question]);
              addMessage(result.next_question, 'ai_interviewer', new Date().toISOString());
              
              // Play TTS for interviewer too if enabled
              if (aiInterviewerConfig.enableVoiceQuestions) {
                playTTSAudio(result.next_question);
              }
            }
            
            if (result.is_complete) {
              setAiInterviewerStatus("complete");
              addMessage(`🎉 AI Interview Completed!`, 'system', new Date().toISOString());
            }
          })
          .catch(error => {
            console.error('❌ Failed to process answer:', error);
            addMessage(`❌ AI Error: ${error.message}`, 'system', new Date().toISOString());
            
            // Notify participant of the failure so they can retry
            if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
              webrtcManagerRef.current.sendData('chat', {
                type: 'answer_error',
                message: 'AI backend failed to process your answer. Please try submitting again.',
                session_id: effectiveSessionId,
                timestamp: new Date().toISOString()
              });
            }
          });
        } else {
          console.warn('⚠️ Cannot submit answer:', { effectiveSessionId, aiInterviewerActive, interviewMode });
          addMessage(`⚠️ Cannot process answer: ${!effectiveSessionId ? 'No Session ID' : 'AI not active'}`, 'system', new Date().toISOString());
        }
        break;
        
      case 'resume_sync_complete':
        console.log('✅ Resume sync complete notification:', data.message);
        addMessage(data.message || 'Resume synchronized', 'system', new Date().toISOString());
        break;
        
      case 'ai_question':
        console.log('📝 Direct AI question received:', data.question);
        if (aiInterviewerActive) {
          setCurrentQuestion(data.question);
          addMessage(data.question, 'ai_interviewer', new Date().toISOString());
        }
        break;
        
      case 'request_ai_question':
        console.log('📥 Participant requesting AI question');
        
        if (currentQuestion) {
          if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
            webrtcManagerRef.current.sendData('chat', {
              type: 'ai_question',
              question: currentQuestion,
              question_index: questionHistory.length - 1,
              total_questions: 5,
              timestamp: new Date().toISOString(),
              session_id: currentSessionId,
              room_id: room.id,
              is_resend: true
            });
          }
        } else if (questionHistory.length > 0) {
          const lastQuestion = questionHistory[questionHistory.length - 1];
          if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
            webrtcManagerRef.current.sendData('chat', {
              type: 'ai_question',
              question: lastQuestion,
              question_index: questionHistory.length - 1,
              total_questions: 5,
              timestamp: new Date().toISOString(),
              session_id: currentSessionId,
              room_id: room.id,
              is_resend: true
            });
          }
        }
        
        addMessage("🔄 Resent AI question to participant", 'system', new Date().toISOString());
        break;
        
      default:
        console.log('📨 Unknown message type:', data.type);
    }
  };

  const handleParticipantModeRequest = (requestedMode, reason = "") => {
    const confirmMessage = `Participant wants to switch to ${requestedMode === "ai" ? "AI" : "Manual"} mode.${reason ? `\nReason: ${reason}` : ''}\n\nAccept this mode change?`;
    
    if (window.confirm(confirmMessage)) {
      setInterviewMode(requestedMode, true);
      
      if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
        webrtcManagerRef.current.sendData('chat', {
          type: 'interview_mode_update',
          mode: requestedMode,
          session_id: currentSessionId,
          timestamp: new Date().toISOString(),
          syncResponse: "accepted",
          source: 'interviewer'
        });
      }
      
      addMessage(
        `✅ Accepted participant's request for ${requestedMode === "ai" ? "AI" : "Manual"} mode.`, 
        'system', 
        new Date().toISOString()
      );
      
    } else {
      if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
        webrtcManagerRef.current.sendData('chat', {
          type: 'interview_mode_update',
          mode: interviewMode,
          session_id: currentSessionId,
          timestamp: new Date().toISOString(),
          syncResponse: "rejected",
          reason: "Interviewer rejected",
          source: 'interviewer'
        });
      }
      
      addMessage(
        `❌ Rejected participant's mode change request.`, 
        'system', 
        new Date().toISOString()
      );
    }
  };

  const updateVideoChatVisibility = (newMode, oldMode) => {
    console.log(`🔄 Updating video and chat visibility: ${oldMode} → ${newMode}`);
    
    if (newMode === "ai" && oldMode === "manual") {
      console.log("📹 Hiding interviewer video, showing chat");
      
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      
      if (!showChat) {
        console.log("💬 Opening chat panel for AI mode");
        setShowChat(true);
      }
      
      if (isScreenSharing) {
        stopScreenShare();
      }
      
    } else if (newMode === "manual" && oldMode === "ai") {
      console.log("📹 Showing interviewer video, closing chat");
      
      if (showChat) {
        console.log("💬 Closing chat panel for manual mode");
        setShowChat(false);
      }
      
      if (mediaStream && isCameraOn && !isScreenSharing && videoRef.current) {
        console.log("📹 Restoring interviewer video");
        
        videoRef.current.srcObject = mediaStream;
        videoRef.current.classList.add('mirror-effect');
        
        const playVideo = () => {
          if (videoRef.current) {
            videoRef.current.play().catch(error => {
              console.warn('Video play failed:', error);
              setTimeout(playVideo, 500);
            });
          }
        };
        
        playVideo();
      } else if (!mediaStream && isCameraOn) {
        console.log("⚠️ Media stream missing but camera is on");
        setTimeout(() => {
          if (isCameraOn && !mediaStream) {
            startCamera();
          }
        }, 1000);
      }
      
      if (isScreenSharing) {
        stopScreenShare();
      }
    }
  };

  const handleModeTransition = (newMode) => {
    const oldMode = interviewMode;
    console.log(`🔄 Handling mode transition from ${oldMode} to ${newMode}`);
    
    updateVideoChatVisibility(newMode, oldMode);
    
    if (newMode === "ai") {
      if (interviewStatus === "active") {
        // Don't automatically set active. Let the config modal or manual start handle it.
        // setAiInterviewerActive(true);
        
        addMessage(
          "🤖 AI Interviewer mode ready. Please ensure participant has uploaded their resume, then click 'Start AI Interview' to begin.", 
          'system', 
          new Date().toISOString()
        );
      }
      
    } else {
      if (aiInterviewerActive) {
        console.log("🛑 Stopping AI Interviewer during mode transition");
        stopAIInterview();
      }
      
      addMessage(
        "👨‍💼 Switching to manual mode. You are now in control of the interview.", 
        'system', 
        new Date().toISOString()
      );
      
      if (webrtcManagerRef.current) {
        webrtcManagerRef.current.sendChatMessage(
          "👋 I'm taking over the interview now. Let's continue manually.",
          `sys-${Date.now()}`
        );
      }
      
      initializeManualMode();
      
      setTimeout(() => {
        if (videoRef.current && mediaStream && isCameraOn && !isScreenSharing) {
          console.log("🔄 Forcing video refresh after mode switch");
          videoRef.current.srcObject = null;
          setTimeout(() => {
            if (videoRef.current && mediaStream) {
              videoRef.current.srcObject = mediaStream;
              videoRef.current.classList.add('mirror-effect');
              videoRef.current.play().catch(console.warn);
            }
          }, 100);
        }
      }, 500);
    }
  };

  const initializeWebRTCManager = () => {
    const user = JSON.parse(localStorage.getItem('interviewUser'));
    const userId = user?.id || 'interviewer-' + Date.now();
    
    console.log(`🚀 Initializing WebRTC manager for interviewer in ${interviewMode} mode...`);
    
    if (webrtcManagerRef.current) {
      console.log('🛑 Cleaning up existing WebRTC manager');
      webrtcManagerRef.current.isClosed = true;
      webrtcManagerRef.current.close();
      webrtcManagerRef.current = null;
    }
    
    webrtcManagerRef.current = createDefaultWebRTCManager(
      room.id, 
      userId, 
      'interviewer',
      {
        onConnectionStateChange: (state) => {
          console.log('🔗 Interviewer WebRTC connection state:', state);
          
          switch (state) {
            case 'connected':
              updateConnectionStatus("connected");
              setChatConnected(true);
              setIsConnecting(false);
              console.log('✅ WebRTC connected with participant!');
              
              if (!webrtcManagerRef.current.isDataChannelOpen('chat')) {
                webrtcManagerRef.current.createDataChannel('chat', {
                  ordered: true,
                  maxRetransmits: 3
                });
                console.log('💬 Chat data channel created');
              }
              
              if (webrtcManagerRef.current?.isDataChannelOpen('chat')) {
                webrtcManagerRef.current.sendData('chat', {
                  type: 'interview_mode_update',
                  mode: interviewMode,
                  session_id: currentSessionId,
                  timestamp: new Date().toISOString()
                });
              }
              
              if (interviewMode === 'ai') {
                if (!showChat) setShowChat(true);
                if (videoRef.current && videoRef.current.srcObject) {
                  videoRef.current.srcObject = null;
                }
              } else {
                if (showChat) setShowChat(false);
              }
              
              if (interviewMode === 'manual' && webrtcManagerRef.current?.isDataChannelOpen('chat')) {
                setTimeout(() => {
                  addMessage("👋 Welcome! I'm your interviewer. Let's begin the interview.", 'interviewer', new Date().toISOString());
                }, 1000);
              }
              break;
              
            case 'connecting':
              updateConnectionStatus("connecting");
              setIsConnecting(true);
              break;
              
            case 'disconnected':
            case 'failed':
              updateConnectionStatus("disconnected");
              setIsConnecting(false);
              setChatConnected(false);
              break;
          }
        },
        
        onTrack: (event) => {
          if (event.streams && event.streams.length > 0) {
            const remoteStream = event.streams[0];
            setParticipantStream(remoteStream);
            setActiveParticipants(1);
            
            const setupVideo = () => {
              if (participantVideoRef.current && remoteStream) {
                participantVideoRef.current.srcObject = remoteStream;
                participantVideoRef.current.play().catch(error => {
                  setTimeout(setupVideo, 500);
                });
              }
            };
            
            setTimeout(setupVideo, 100);
          }
        },
        
        onMessage: (data) => {
          handleWebRTCMessage(data);
        },
        
        onDataChannel: (channel) => {
          if (channel.label === 'chat') {
            console.log('💬 Chat data channel opened');
            setChatConnected(true);
            
            setTimeout(() => {
              if (interviewMode === 'manual') {
                webrtcManagerRef.current.sendChatMessage(
                  "👋 Hello! I'm ready to start the interview.",
                  `welcome-${Date.now()}`
                );
              }
            }, 1000);
          }
        },
        
        onParticipantJoined: (data) => {
          setActiveParticipants(1);
          setIsConnecting(true);
          updateConnectionStatus("connecting");
          
          setTimeout(async () => {
            if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed) {
              try {
                await webrtcManagerRef.current.createOffer();
              } catch (error) {
                console.error('❌ Failed to create offer:', error);
              }
            }
          }, 1500);
        },
        
        onOpen: () => {
          setSignalingConnected(true);
        },
        
        onClose: () => {
          setSignalingConnected(false);
          setChatConnected(false);
        },
        
        onError: (error) => {
          console.error('❌ Interviewer WebRTC error:', error);
          updateConnectionStatus("error");
          setIsConnecting(false);
        },
        
        onPeerDisconnected: (data) => {
          console.log('👋 Peer disconnected:', data);
          setActiveParticipants(0);
          setParticipantStream(null);
          updateConnectionStatus("disconnected");
          setChatConnected(false);
          addMessage("👋 Participant has left the room", 'system', new Date().toISOString());
        }
      }
    );
  };

  // Improved connectWebSocket function with better keep-alive
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
      console.log('🔌 Interviewer connecting to consolidated AI backend at ws://localhost:8001/ws');
      const ws = new WebSocket("ws://localhost:8001/ws");
      let pingInterval = null;
      let pongTimeout = null;
      
      ws.onopen = () => {
        console.log("✅ Interviewer WebSocket connected");
        setAiConnected(true);
        reconnectAttemptsRef.current = 0;
        
        // Setup Heartbeat
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            
            if (pongTimeout) clearTimeout(pongTimeout);
            pongTimeout = setTimeout(() => {
              console.warn("⚠️ WebSocket pong timeout - reconnecting");
              if (ws.readyState === WebSocket.OPEN) ws.close();
            }, 10000);
          }
        }, 20000);
        
        if (currentSessionId) {
          ws.send(JSON.stringify({
            type: 'register_session',
            session_id: currentSessionId,
            room_id: room.id
          }));
        }
      };
      
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'ping') {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            return;
          }
          if (data.type === 'pong') {
            if (pongTimeout) {
              clearTimeout(pongTimeout);
              pongTimeout = null;
            }
            return;
          }
          
          switch (data.type) {
            case 'session_registered':
              console.log('✅ Session registered with AI backend');
              setAiInterviewerStatus("connected");
              break;

            case 'interview_started':
            case 'ai_interview_started':
              setAiInterviewerActive(true);
              if (data.questions?.length > 0) {
                const q = data.questions[0];
                setCurrentQuestion(q);
                setQuestionHistory([q]);
                addMessage(q, 'ai_interviewer', new Date().toISOString());
                
                // Inform participant via WebRTC
                if (webrtcManagerRef.current?.isDataChannelOpen('chat')) {
                  webrtcManagerRef.current.sendData('chat', {
                    type: 'ai_interview_started',
                    questions: data.questions,
                    session_id: currentSessionId,
                    room_id: room.id
                  });
                }
                
                // Interviewer Local TTS (optional)
                if (aiInterviewerConfig.enableVoiceQuestions) playTTSAudio(q);
              }
              break;

            case 'answer_result':
            case 'ai_answer_feedback':
              console.log('📊 Answer feedback received:', data);
              if (data.score !== undefined) {
                addMessage(`📊 Participant Score: ${data.score}/10 - ${data.feedback || ''}`, 'system', new Date().toISOString());
              }
              
              if (data.next_question) {
                setCurrentQuestion(data.next_question);
                setQuestionHistory(prev => [...prev, data.next_question]);
                addMessage(data.next_question, 'ai_interviewer', new Date().toISOString());
                
                // Inform participant via WebRTC
                if (webrtcManagerRef.current?.isDataChannelOpen('chat')) {
                  webrtcManagerRef.current.sendData('chat', {
                    type: 'ai_answer_feedback',
                    score: data.score,
                    feedback: data.feedback,
                    next_question: data.next_question,
                    session_id: currentSessionId
                  });
                }
                
                if (aiInterviewerConfig.enableVoiceQuestions) playTTSAudio(data.next_question);
              } else if (data.is_complete || data.final_results) {
                setAiInterviewerStatus("complete");
                if (webrtcManagerRef.current?.isDataChannelOpen('chat')) {
                  webrtcManagerRef.current.sendData('chat', {
                    type: 'ai_answer_feedback',
                    final_results: data.final_results,
                    is_complete: true,
                    session_id: currentSessionId
                  });
                }
              }
              break;

            case 'fraud_alert':
              addMessage(`⚠️ Participant Alert: ${data.message}`, 'system', new Date().toISOString());
              break;

            default:
              // Handle detection data (interviewer perspective)
              if (data.faces !== undefined) {
                handleWebSocketMessage(data); // Reuse existing handler
              }
          }
        } catch (err) {
          console.error("❌ WS message error:", err);
        }
      };
      
      ws.onclose = (e) => {
        if (pingInterval) clearInterval(pingInterval);
        if (pongTimeout) clearTimeout(pongTimeout);
        setAiConnected(false);
        console.log(`🔌 WS closed: ${e.code}`);
        
        if (!isExplicitlyClosing && reconnectAttemptsRef.current < 5) {
          setTimeout(() => {
            reconnectAttemptsRef.current++;
            connectWebSocket();
          }, 3000);
        }
      };
      
      ws.onerror = () => setAiConnected(false);
      wsRef.current = ws;
      wsRef.current.pingInterval = pingInterval;
      wsRef.current.pongTimeout = pongTimeout;
      
    } catch (err) {
      console.error("❌ WS connect failed:", err);
    }
  };

  const playTTSAudio = (text) => {
    if (!aiInterviewerConfig.enableVoiceQuestions) return;
    
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
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
      
      window.speechSynthesis.speak(utterance);
    }
  };

  // FIXED: Improved startResumeBasedAIInterview with proper JSON
  const startResumeBasedAIInterview = async () => {
    if (!resumeData || !currentSessionId) {
      alert("Resume not available or session not ready");
      return;
    }

    if (interviewMode !== "ai") {
      alert("Please switch to AI mode first");
      return;
    }

    try {
      console.log('🤖 Starting resume-based AI interview...');
      console.log('📝 Session ID:', currentSessionId);
      console.log('📝 Room ID:', room.id);
      
      setAiInterviewerActive(true);
      setAiInterviewerStatus("starting");
      
      // Use POST with JSON body (not query params)
      const response = await fetch(`${PYTHON_API_URL}/start_ai_interview`, {
        method: "POST",
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          session_id: currentSessionId,
          level: aiInterviewerConfig.difficulty || "medium",
          room_id: room.id
        })
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ AI interview start failed:', errorText);
        
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.message || errorText;
        } catch {
          errorMessage = errorText;
        }
        
        throw new Error(errorMessage);
      }
      
      const result = await response.json();
      console.log('✅ AI Interview started:', result);
      
      if (result.status === "error") {
        throw new Error(result.message);
      }
      
      // Connect to AI WebSocket
      // connectToAIInterviewer consolidated into connectWebSocket;
      
      if (result.questions && result.questions.length > 0) {
        const firstQuestion = result.questions[0];
        console.log('📝 Setting and sending first question:', firstQuestion);
        
        setCurrentQuestion(firstQuestion);
        setQuestionHistory([firstQuestion]);
        addMessage(firstQuestion, 'ai_interviewer', new Date().toISOString());
        
        // Play TTS for first question
        if (aiInterviewerConfig.enableVoiceQuestions && 'speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(firstQuestion);
          utterance.rate = 0.95;
          utterance.pitch = 1.0;
          utterance.volume = 1.0;
          utterance.lang = 'en-US';
          
          utterance.onstart = () => {
            setAiInterviewerStatus("speaking");
          };
          
          utterance.onend = () => {
            setAiInterviewerStatus("listening");
            addMessage("👂 Waiting for participant response...", 'system', new Date().toISOString());
          };
          
          window.speechSynthesis.speak(utterance);
        } else {
          setTimeout(() => {
            setAiInterviewerStatus("listening");
          }, 3000);
        }
        
        // Send AI question to participant via WebRTC chat
        if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
          console.log('📤 Sending AI question to participant via WebRTC');
          
          const messageSent = webrtcManagerRef.current.sendData('chat', {
            type: 'ai_question',
            question: firstQuestion,
            question_index: 0,
            total_questions: result.questions.length,
            timestamp: new Date().toISOString(),
            session_id: currentSessionId,
            room_id: room.id,
            message: 'AI Interview starting now'
          });
          
          if (!messageSent) {
            console.warn('⚠️ Failed to send AI question via data channel, trying chat message fallback');
            webrtcManagerRef.current.sendChatMessage(
              `🤖 AI Question 1/${result.questions.length}: ${firstQuestion}`,
              `aiq-${Date.now()}`
            );
          }
        } else {
          console.warn('⚠️ Chat data channel not open, sending question as fallback');
          if (webrtcManagerRef.current) {
            webrtcManagerRef.current.sendChatMessage(
              `🤖 AI Question 1/${result.questions.length}: ${firstQuestion}`,
              `aiq-${Date.now()}`
            );
          }
        }
      }
      
      addMessage("🤖 AI Interview started based on participant's resume!", 'system', new Date().toISOString());
      alert("✅ AI interview started! Participant will now receive AI questions.");
      
    } catch (error) {
      console.error('❌ Error starting AI interview:', error);
      setAiInterviewerActive(false);
      setAiInterviewerStatus("error");
      
      alert(`Failed to start AI interview:\n\n${error.message}`);
    }
  };

  const startAIInterview = async () => {
    if (!aiInterviewerActive || interviewMode !== 'ai') return;
    
    try {
      console.log('🤖 Starting AI Interview...');
      setAiInterviewerStatus("starting");
      
      // connectToAIInterviewer consolidated into connectWebSocket;
      connectWebSocket();
      
    } catch (error) {
      console.error('❌ Error starting AI interview:', error);
      setAiInterviewerStatus("error");
    }
  };

  const stopAIInterview = () => {
    console.log('🛑 Stopping AI Interview...');
    setAiInterviewerActive(false);
    setAiInterviewerStatus("idle");
    
    if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
      webrtcManagerRef.current.sendData('chat', {
        type: 'ai_interviewer_stop',
        session_id: currentSessionId,
        timestamp: new Date().toISOString(),
        message: 'AI Interview stopped by interviewer'
      });
    }
    
    if (currentSessionId) {
      fetch(`${PYTHON_API_URL}/end_ai_interview`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: currentSessionId })
      })
      .catch(error => {
        console.error('❌ Error ending AI interview on backend:', error);
      });
    }
    
    if (null /* consolidated */) {
      if (null /* consolidated */.pingInterval) clearInterval(null /* consolidated */.pingInterval);
      if (null /* consolidated */.pongTimeout) clearTimeout(null /* consolidated */.pongTimeout);
      null /* consolidated */.close();
    }
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    
    setCurrentQuestion("");
    setCandidateResponse("");
    setQuestionHistory([]);
    setResponseAnalysis(null);
  };

  const toggleAIInterviewer = () => {
    if (aiInterviewerActive) {
      stopAIInterview();
    } else {
      if (resumeData) {
        startResumeBasedAIInterview();
      } else {
        alert("No resume uploaded yet. Ask participant to upload resume first.");
      }
    }
  };

  const handleDynamicModeSwitch = async (newMode) => {
    if (newMode === interviewMode) return;
    
    console.log(`🔄 Attempting dynamic mode switch from ${interviewMode} to ${newMode}`);
    
    if (interviewStatus === "active") {
      const confirmMessage = `Switch to ${newMode === "ai" ? "AI" : "Manual"} mode?\n\nThis will: ${
        newMode === "ai" 
          ? "Hide your video, open chat panel, and activate AI Interviewer"
          : "Show your video, close chat panel, and return to manual control"
      }\n\nThis will affect both you and the participant.`;
      
      if (!window.confirm(confirmMessage)) {
        return;
      }
    }
    
    try {
      setInterviewMode(newMode, true);
      
      addMessage(
        `🔄 Switching to ${newMode === "ai" ? "AI" : "Manual"} mode...`, 
        'system', 
        new Date().toISOString()
      );
      
      if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
        webrtcManagerRef.current.sendData('chat', {
          type: 'interview_mode_update',
          mode: newMode,
          session_id: currentSessionId,
          timestamp: new Date().toISOString(),
          syncRequest: true,
          source: 'interviewer',
          reason: "Interviewer initiated mode change"
        });
      }
      
      if (modeSyncTimeoutRef.current) {
        clearTimeout(modeSyncTimeoutRef.current);
      }
      
      modeSyncTimeoutRef.current = setTimeout(() => {
        if (syncStatus === "requested") {
          console.warn("⏰ Mode sync timeout - participant may not have responded");
          addMessage(
            "⚠️ Mode sync timeout. Participant may still be in previous mode.", 
            'system', 
            new Date().toISOString()
          );
          if (breakSync) breakSync();
        }
      }, 10000);
      
      handleModeTransition(newMode);
      
      setTimeout(() => {
        addMessage(
          `✅ Successfully switched to ${newMode === "ai" ? "AI" : "Manual"} mode.`, 
          'system', 
          new Date().toISOString()
        );
      }, 1000);
      
    } catch (error) {
      console.error("❌ Error switching mode:", error);
      
      addMessage(
        `❌ Failed to switch mode: ${error.message}`, 
        'system', 
        new Date().toISOString()
      );
      
      alert(`Failed to switch mode: ${error.message}`);
    }
  };

  const handleInterviewModeChange = (newMode) => {
    console.log(`🔄 Mode change requested: ${newMode}`);
    
    if (newMode === interviewMode) {
      console.log("⚠️ Already in this mode");
      return;
    }
    
    if (interviewStatus === "active") {
      handleDynamicModeSwitch(newMode);
    } else {
      console.log(`🔄 Setting interview mode to ${newMode}`);
      setInterviewMode(newMode);
      
      updateVideoChatVisibility(newMode, interviewMode);
      
      if (newMode === "ai") {
        setShowAIConfigModal(true);
      }
    }
  };

  const startCamera = async () => {
    try {
      console.log('🎥 Interviewer starting camera...');
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
      
      setMediaStream(stream);
      
      if (videoRef.current && interviewMode === 'manual' && !(interviewMode === 'ai' && aiInterviewerActive)) {
        videoRef.current.srcObject = stream;
        videoRef.current.classList.add('mirror-effect');
        videoRef.current.onloadedmetadata = () => {
          videoRef.current.play().catch(console.warn);
        };
      }
      
      setIsCameraOn(true);
      setIsMicOn(true);
      
      initializeWebRTCManager();
      
      if (webrtcManagerRef.current) {
        await webrtcManagerRef.current.connect();
        await webrtcManagerRef.current.setLocalStream(stream);
        
        webrtcManagerRef.current.createDataChannel('chat', {
          ordered: true,
          maxRetransmits: 3
        });
      }
      
      await createSession();
      
      console.log('✅ Interviewer camera started successfully');
      setIsConnecting(false);
      
      const welcomeMessage = interviewMode === 'ai' 
        ? "🎥 Camera started. Waiting for participant to join..."
        : "🎥 Camera started. You are now hosting the interview room. Share the Room ID with the participant.";
      addMessage(welcomeMessage, 'system', new Date().toISOString());
      
    } catch (err) {
      console.error("❌ Interviewer error accessing media devices:", err);
      alert("Could not access camera. Please check permissions.");
      setIsConnecting(false);
      setIsCameraOn(false);
    }
  };

  const stopCamera = () => {
    console.log('🛑 Interviewer stopping camera...');
    setIsExplicitlyClosing(true);
    
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    
    if (modeSyncTimeoutRef.current) {
      clearTimeout(modeSyncTimeoutRef.current);
      modeSyncTimeoutRef.current = null;
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
    
    if (null /* consolidated */) {
      if (null /* consolidated */.pingInterval) clearInterval(null /* consolidated */.pingInterval);
      if (null /* consolidated */.pongTimeout) clearTimeout(null /* consolidated */.pongTimeout);
      null /* consolidated */.close();
      setAiInterviewerStatus("disconnected");
    }
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    
    if (webrtcManagerRef.current) {
      webrtcManagerRef.current.isClosed = true;
      webrtcManagerRef.current.close();
      webrtcManagerRef.current = null;
    }
    
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop());
    }
    
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
    }
    
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (participantVideoRef.current) {
      participantVideoRef.current.srcObject = null;
    }
    
    setIsCameraOn(false);
    setIsMicOn(false);
    setIsScreenSharing(false);
    setIsParticipantScreenSharing(false);
    setParticipantStream(null);
    setActiveParticipants(0);
    setConnectionStatus("disconnected");
    setChatConnected(false);
    setSignalingConnected(false);
    setIsConnecting(false);
    setAiInterviewerActive(false);
    setAiInterviewerStatus("idle");
    setResumeData(null);
    setConnectionRetryCount(0);
    reconnectAttemptsRef.current = 0;
    setIsExplicitlyClosing(false);
    
    console.log('✅ Interviewer camera stopped');
  };

  const initializeManualMode = () => {
    console.log('👨‍💼 Initializing manual interview mode...');
    
    if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed) {
      if (!webrtcManagerRef.current.isDataChannelOpen('chat')) {
        webrtcManagerRef.current.createDataChannel('chat', {
          ordered: true,
          maxRetransmits: 3
        });
      }
      
      const checkConnection = setInterval(() => {
        if (connectionStatus === 'connected' && chatConnected && !isExplicitlyClosing) {
          clearInterval(checkConnection);
          setTimeout(() => {
            addMessage("👋 Hello! Welcome to the interview. I'll be conducting your interview today.", 'interviewer', new Date().toISOString());
          }, 1000);
        }
      }, 1000);
    }
  };

  const startInterview = async () => {
    try {
      console.log(`🎬 Starting interview in ${interviewMode} mode...`);
      setIsConnecting(true);
      setIsExplicitlyClosing(false);
      
      await startCamera();
      
      const sessionId = await createSession();
      if (!sessionId) {
        alert('❌ Failed to create session');
        setIsConnecting(false);
        return;
      }
      
      connectWebSocket();
      
      try {
        const response = await fetch(`${PYTHON_API_URL}/start_interview?session_id=${sessionId}&room_id=${room.id}`, {
          method: "POST",
          headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
          console.log('✅ Python backend interview session started');
        } else {
          console.warn('⚠️ Could not start interview on Python backend');
        }
      } catch (err) {
        console.warn('⚠️ Could not connect to Python backend, continuing without it');
      }
      
      if (interviewMode === 'ai') {
        if (!showChat) setShowChat(true);
        if (videoRef.current && videoRef.current.srcObject) {
          videoRef.current.srcObject = null;
        }
        
        addMessage("🤖 AI Interviewer mode ready. Wait for participant to upload resume.", 'system', new Date().toISOString());
      } else {
        if (showChat) setShowChat(false);
        addMessage("👨‍💼 Manual Interview mode activated. You are now in control of the interview.", 'system', new Date().toISOString());
        addMessage("Share this Room ID with the participant: " + room.id, 'system', new Date().toISOString());
        initializeManualMode();
      }
      
      setInterviewStatus("active");
      setSessionStartTime(new Date());
      setIsConnecting(false);
      
      setTimeout(() => {
        if (participantVideoRef.current && aiConnected && !isExplicitlyClosing) {
          if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
          frameIntervalRef.current = setInterval(captureAndSendFrame, 1000);
          console.log('🎥 Started frame capture interval');
        }
      }, 2000);
      
    } catch (err) {
      console.error("❌ Interviewer error starting interview:", err);
      alert("Error starting interview: " + err.message);
      setIsConnecting(false);
    }
  };

  const stopInterview = async () => {
    try {
      console.log('🛑 Interviewer stopping interview...');
      
      if (aiInterviewerActive) {
        stopAIInterview();
      }
      
      stopCamera();
      
      try {
        await fetch(`${PYTHON_API_URL}/stop_interview`, {
          method: "POST",
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        console.warn('⚠️ Could not notify Python backend');
      }
      
      setInterviewStatus("inactive");
      
      if (currentSessionId) {
        await generateFinalReport();
        try {
          await fetch(`${NODE_API_URL}/detections/session/end`, {
            method: "POST",
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: currentSessionId })
          });
        } catch (error) {
          console.warn('⚠️ Could not end session on server');
        }
      }
      
      alert('✅ Interview stopped successfully!');
    } catch (err) {
      console.error("❌ Interviewer error stopping interview:", err);
      alert("Error stopping interview: " + err.message);
    }
  };

  const createSession = async () => {
    try {
      const user = JSON.parse(localStorage.getItem('interviewUser'));
      if (!user) {
        console.error('No user found');
        return null;
      }
      
      const sessionId = `session-${room.id}-interviewer-${Date.now()}`;
      const response = await fetch(`${NODE_API_URL}/detections/session/start`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          roomId: room.id,
          userId: user.id,
          userType: 'interviewer',
          interviewMode: interviewMode
        })
      });
      
      const result = await response.json();
      if (result.success) {
        console.log('✅ Interviewer session created:', sessionId);
        setCurrentSessionId(sessionId);
        setSessionStartTime(new Date());
        return sessionId;
      } else {
        console.error('❌ Failed to create interviewer session:', result.message);
        return null;
      }
    } catch (error) {
      console.error('❌ Error creating interviewer session:', error);
      return null;
    }
  };

  const saveDetectionData = async (detectionData) => {
    try {
      if (!currentSessionId) return;
      await fetch(`${NODE_API_URL}/detections/save`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          roomId: room.id,
          userId: JSON.parse(localStorage.getItem('interviewUser'))?.id,
          timestamp: new Date(),
          ...detectionData
        })
      });
    } catch (error) {
      console.error('Error saving detection:', error);
    }
  };

  // FIXED: Improved frame capture with better error handling
  const captureAndSendFrame = () => {
    if (!participantVideoRef.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }
    
    if (isExplicitlyClosing) return;
    
    try {
      const video = participantVideoRef.current;
      
      if (video.videoWidth === 0 || video.videoHeight === 0 || video.readyState !== 4) {
        return;
      }
      
      if (!canvasRef.current) {
        canvasRef.current = document.createElement('canvas');
      }
      
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      const imageData = canvas.toDataURL('image/jpeg', 0.6); // Slightly lower quality for stability
      
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && currentSessionId) {
        // Ensure we don't send if session ID is literally "None" or null
        if (!currentSessionId || currentSessionId === "None") return;
        
        const frameData = {
          type: 'participant_frame',
          image: imageData,
          timestamp: Date.now(),
          roomId: room.id,
          sessionId: currentSessionId,
          userId: 'interviewer'
        };
        wsRef.current.send(JSON.stringify(frameData));
        
        setFrameCount(prev => prev + 1);
        
        // Log every 50 frames
        if (frameCount % 50 === 0) {
          console.log('🎥 Frame sent for detection');
        }
      }
    } catch (error) {
      console.error('❌ Error capturing frame:', error);
      canvasRef.current = null;
    }
  };

  const captureReferenceFace = async () => {
    if (!participantVideoRef.current) {
      alert("No participant video available.");
      return;
    }
    
    try {
      setCapturingReference(true);
      console.log('👤 Starting reference face capture...');
      
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const video = participantVideoRef.current;
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        alert("Participant video not ready. Please wait for video to load.");
        setCapturingReference(false);
        return;
      }
      
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      
      const imageData = canvas.toDataURL('image/jpeg', 0.9);
      
      const response = await fetch(`${PYTHON_API_URL}/set_reference_face`, {
        method: "POST",
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session_id: currentSessionId || `session-${Date.now()}`,
          image_data: imageData
        })
      });
      
      console.log('📤 Reference face upload response status:', response.status);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Reference face upload failed:', errorText);
        
        let errorMessage = `HTTP error! status: ${response.status}`;
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.message || errorMessage;
        } catch (e) {
          // Keep the default error message
        }
        
        throw new Error(errorMessage);
      }
      
      const result = await response.json();
      console.log('✅ Reference face capture result:', result);
      
      if (result.status === "success") {
        setReferenceFaceSet(true);
        alert('✅ Reference face captured successfully!');
        
        setAiResults(prev => ({
          ...prev,
          verification: "Reference Set"
        }));
      } else {
        throw new Error(result.message || 'No face detected');
      }
      
    } catch (error) {
      console.error('❌ Error capturing reference face:', error);
      alert(`Error capturing reference face: ${error.message}\n\nPlease ensure participant's face is clearly visible with good lighting.`);
    } finally {
      setCapturingReference(false);
    }
  };

  const handleCaptureReference = async () => {
    if (!isParticipantVideoReady()) {
      alert("Participant video is not ready.");
      return;
    }
    if (!activeParticipants) {
      alert("No participant connected.");
      return;
    }
    await captureReferenceFace();
  };

  const isParticipantVideoReady = () => {
    if (!participantVideoRef.current) return false;
    const video = participantVideoRef.current;
    return video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
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
    
    if (sender === 'participant' && !showChat) setUnreadMessages(prev => prev + 1);
  };

  const sendMessage = () => {
    if (newMessage.trim() === "") return;
    
    const timestamp = new Date().toISOString();
    const messageText = newMessage.trim();
    const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    console.log('📤 Sending message:', messageText);
    
    addMessage(messageText, 'interviewer', timestamp, messageId);
    setUnreadMessages(0);
    
    if (webrtcManagerRef.current && !webrtcManagerRef.current.isClosed) {
      const success = webrtcManagerRef.current.sendChatMessage(messageText, messageId);
      if (!success) {
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

  const toggleChat = () => {
    setShowChat(!showChat);
    if (!showChat) setUnreadMessages(0);
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
    const audioTrack = mediaStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsMicOn(audioTrack.enabled);
    }
  };

  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        console.log('🖥️ Interviewer starting screen share...');
        
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

        setScreenStream(screenStream);
        
        if (videoRef.current && interviewMode === 'manual' && !aiInterviewerActive) {
          videoRef.current.srcObject = screenStream;
          videoRef.current.classList.remove('mirror-effect');
          videoRef.current.play().catch(console.warn);
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

        console.log('✅ Interviewer screen sharing started successfully');
      } catch (err) {
        console.error("❌ Interviewer error sharing screen:", err);
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
    console.log('🛑 Interviewer stopping screen share...');
    
    if (screenStream) {
      screenStream.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      setScreenStream(null);
    }
    
    if (videoRef.current && mediaStream && interviewMode === 'manual' && !aiInterviewerActive) {
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
    
    console.log('✅ Interviewer screen share stopped');
  };

  const checkConnectionHealth = useCallback(() => {
    if (!webrtcManagerRef.current || webrtcManagerRef.current.isClosed) return 'closed';
    
    const status = webrtcManagerRef.current.getStatus?.();
    console.log('🔍 Connection health check:', status);
    
    if (status && status.signaling === 'connected' && 
        status.peerConnection === 'failed' && 
        isCameraOn && interviewStatus === "active" &&
        !webrtcManagerRef.current.isReconnecting && !isExplicitlyClosing) {
      console.log('🔄 Restarting ICE due to failed connection...');
      webrtcManagerRef.current.restartIce().catch(console.error);
    }
    
    return status?.peerConnection || 'disconnected';
  }, [isCameraOn, interviewStatus]);

  const checkChatConnection = () => {
    if (!webrtcManagerRef.current || webrtcManagerRef.current.isClosed) return false;
    
    const status = webrtcManagerRef.current.getStatus?.();
    const chatChannel = status?.dataChannels?.find(ch => ch.label === 'chat');
    
    if (chatChannel && chatChannel.state === 'open') {
      return true;
    }
    
    if (!webrtcManagerRef.current.isDataChannelOpen('chat') && !isExplicitlyClosing) {
      webrtcManagerRef.current.createDataChannel('chat', {
        ordered: true,
        maxRetransmits: 3
      });
    }
    
    return false;
  };

  const generateFinalReport = async () => {
    if (!currentSessionId) {
      alert("No active session found. Cannot generate report.");
      return;
    }
    
    setIsGeneratingReport(true);
    try {
      const sessionDuration = calculateDuration();
      const performanceScore = calculatePerformanceScore(aiResults);
      
      const response = await fetch(`${NODE_API_URL}/detections/generate-report`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          roomId: room.id,
          includeChat: true,
          includeAiMetrics: true,
          duration: sessionDuration,
          sessionStartTime: sessionStartTime,
          sessionEndTime: new Date(),
          aiResults: {
            ...aiResults,
            performance_score: performanceScore
          },
          chatMessages: messages,
          performanceScore: performanceScore,
          interviewMode: interviewMode,
          aiInterviewerData: {
            questionHistory,
            responseAnalysis,
            resumeData
          }
        })
      });
      
      const result = await response.json();
      if (result.success) {
        setFinalReport(result.report);
        setShowReportModal(true);
        console.log("Final report generated successfully:", result.report);
      } else {
        alert("Failed to generate report: " + result.message);
      }
    } catch (error) {
      console.error("Error generating report:", error);
      alert("Error generating report: " + error.message);
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const downloadReport = async () => {
    if (!finalReport) return;
    try {
      const response = await fetch(`${NODE_API_URL}/detections/download-report`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          report: finalReport,
          roomId: room.id
        })
      });
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `interview-report-${room.id}-${new Date().toISOString().split('T')[0]}.pdf`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        alert("Report downloaded successfully!");
      } else {
        const errorData = await response.json();
        alert("Failed to download report: " + (errorData.message || 'Unknown error'));
      }
    } catch (error) {
      console.error("Error downloading report:", error);
      alert("Error downloading report: " + error.message);
    }
  };

  const sendReportToParticipant = async () => {
    if (!finalReport) return;
    try {
      const response = await fetch(`${NODE_API_URL}/detections/share-report`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          roomId: room.id,
          report: finalReport,
          recipient: 'participant',
          sender: 'interviewer'
        })
      });
      const result = await response.json();
      if (result.success) {
        alert("Report sent to participant successfully!");
      } else {
        alert("Failed to send report to participant: " + result.message);
      }
    } catch (error) {
      console.error("Error sending report to participant:", error);
      alert("Error sending report: " + error.message);
    }
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(room.id)
      .then(() => alert('✅ Room ID copied to clipboard!'))
      .catch(err => {
        console.error('Failed to copy room ID: ', err);
        alert('Failed to copy Room ID. Please copy it manually.');
      });
  };

  const handleLeaveMeeting = async () => {
    setIsExplicitlyClosing(true);
    if (interviewStatus === "active") await stopInterview();
    else if (currentSessionId) await generateFinalReport();
    
    stopCamera();
    
    onLeave();
  };

  const handleAIConfigSubmit = () => {
    console.log("AI Interviewer Configuration Saved:", aiInterviewerConfig);
    setShowAIConfigModal(false);
    
    // Automatically start the AI interview if we have resume data
    if (resumeData) {
      startResumeBasedAIInterview();
    } else {
      alert("Configuration saved! AI Interview will start once the participant uploads their resume.");
      
      // Notify participant that we are ready and waiting for resume
      if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat')) {
        webrtcManagerRef.current.sendData('chat', {
          type: 'ai_interviewer_ready',
          sessionId: currentSessionId,
          timestamp: new Date().toISOString(),
          message: 'Interviewer is ready. Please upload your resume to start.'
        });
      }
    }
  };

  useEffect(() => {
    if (participantStream && participantVideoRef.current) {
      participantVideoRef.current.srcObject = participantStream;
      
      const playVideo = () => {
        if (participantVideoRef.current) {
          participantVideoRef.current.play().catch(error => {
            setTimeout(playVideo, 500);
          });
        }
      };
      
      playVideo();
    }
  }, [participantStream]);

  useEffect(() => {
    if (webrtcManagerRef.current && webrtcManagerRef.current.isDataChannelOpen('chat') && !webrtcManagerRef.current.isClosed) {
      webrtcManagerRef.current.sendData('chat', {
        type: 'interview_mode_update',
        mode: interviewMode,
        sessionId: currentSessionId,
        timestamp: new Date().toISOString()
      });
      
      console.log(`📤 Sent mode update to participant: ${interviewMode} with Session ID: ${currentSessionId}`);
    }
    
    // Also register session with WebSocket if available
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && currentSessionId) {
      console.log('🔌 Registering session with AI backend via WS:', currentSessionId);
      wsRef.current.send(JSON.stringify({
        type: 'register_session',
        session_id: currentSessionId,
        room_id: room.id
      }));
    }
  }, [interviewMode, currentSessionId, aiConnected]);

  useEffect(() => {
    if (chatMessagesRef.current) {
      chatMessagesRef.current.scrollTop = chatMessagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (showChat) setUnreadMessages(0);
  }, [showChat]);

  useEffect(() => {
    if (isParticipantVideoReady() && aiConnected && interviewStatus === "active" && !isExplicitlyClosing) {
      if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = setInterval(captureAndSendFrame, 1000);
      console.log('🎥 Started frame capture for detection');
    }
    
    return () => {
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current);
      }
    };
  }, [isParticipantVideoReady(), aiConnected, interviewStatus]);

  useEffect(() => {
    if (interviewStatus === "active" && isCameraOn && !isExplicitlyClosing) {
      connectionMonitorRef.current = setInterval(() => {
        checkConnectionHealth();
      }, 30000);
    }
    
    return () => {
      if (connectionMonitorRef.current) {
        clearInterval(connectionMonitorRef.current);
      }
    };
  }, [interviewStatus, isCameraOn, checkConnectionHealth]);

  useEffect(() => {
    if (connectionStatus === 'connected') {
      const interval = setInterval(() => {
        if (!isExplicitlyClosing) {
          const isChatConnected = checkChatConnection();
          setChatConnected(isChatConnected);
        }
      }, 3000);
      
      return () => clearInterval(interval);
    }
  }, [connectionStatus]);

  useEffect(() => {
    console.log('🏠 InterviewRoom mounted');
    
    return () => {
      console.log('🧹 InterviewRoom cleanup');
      setIsExplicitlyClosing(true);
      stopCamera();
      
      if (modeSyncTimeoutRef.current) {
        clearTimeout(modeSyncTimeoutRef.current);
      }
      
      if (connectionMonitorRef.current) {
        clearInterval(connectionMonitorRef.current);
      }
    };
  }, []);

  const GenerateReportButton = () => {
    if (interviewStatus === "active") return null;
    return (
      <button
        onClick={generateFinalReport}
        disabled={isGeneratingReport || !currentSessionId}
        className={`generate-report-button ${isGeneratingReport ? 'generating' : ''}`}
      >
        <span className="report-text">
          {isGeneratingReport ? 'Generating Report...' : 'Generate Report'}
        </span>
      </button>
    );
  };

  const ResumePanel = () => (
    <div className="resume-header-panel">
      <button 
        className={`resume-download-button ${resumeData ? 'has-resume' : 'no-resume'}`}
        onClick={() => {
          if (resumeData) {
            alert(`Resume available!\n\nFilename: ${resumeData.filename}\nMode: ${resumeData.manualMode ? 'Manual' : 'AI'}\nRoom: ${resumeData.roomId}`);
          }
        }}
        title={resumeData ? `Resume from participant (${resumeData.manualMode ? 'Manual' : 'AI'} mode)` : 'No resume'}
      >
        <span className="resume-icon">📄</span>
        <span className="resume-text">
          {resumeData ? 'Resume Ready' : 'No Resume'}
        </span>
        {resumeData?.manualMode && <span className="manual-mode-indicator">👤</span>}
      </button>
      
      {!resumeData && interviewMode === "ai" && interviewStatus === "active" && (
        <button 
          className="start-ai-from-resume-button"
          onClick={() => alert("Please ask the participant to upload their resume first")}
          title="Resume required for AI interview"
        >
          <span className="ai-icon">🤖</span>
          <span className="ai-text">Need Resume</span>
        </button>
      )}
    </div>
  );

  return (
    <div className={`interview-room ${interviewMode === 'ai' ? 'ai-mode' : ''}`}>
      <div className="room-header">
        <div className="header-left">
          <h2>True Hire</h2>
          <span className={`room-status ${room.isJoining ? 'joined' : 'hosting'}`}>
            {room.isJoining ? 'JOINED' : 'HOSTING'}
          </span>
          <span className={`connection-status ${connectionStatus}`}>
            {connectionStatus === 'connected' ? '● Connected' : 
            connectionStatus === 'connecting' ? '● Connecting...' : 
            '● Disconnected'}
          </span>
          {syncStatus === "synced" && (
            <span className="sync-badge">🔄 Synced</span>
          )}
          {syncStatus === "requested" && (
            <span className="sync-pending-badge">⏳ Syncing...</span>
          )}
        </div>
        <div className="header-right">
          <ResumePanel />
          <div className="ai-interviewer-controls">
            <div className="mode-selector">
              <label>Mode:</label>
              <select 
                value={interviewMode} 
                onChange={(e) => handleInterviewModeChange(e.target.value)}
                className={interviewStatus === "active" ? "active-interview-mode" : ""}
                title={interviewStatus === "active" ? "Switch mode during interview" : "Set initial mode"}
              >
                <option value="manual">Manual</option>
                <option value="ai">AI</option>
              </select>
              {interviewStatus === "active" && (
                <span className="dynamic-switch-indicator" title="Dynamic mode switching enabled">
                  🔄
                </span>
              )}
            </div>
            
            {interviewMode === "ai" && interviewStatus === "active" && (
              <div className="ai-controls">
                <button
                  onClick={toggleAIInterviewer}
                  className={`ai-toggle-button ${aiInterviewerActive ? 'active' : ''}`}
                  disabled={!activeParticipants || connectionStatus !== 'connected' || !resumeData}
                  title={!resumeData ? "Wait for participant to upload resume" : "Start/Stop AI Interview"}
                >
                  {aiInterviewerActive ? "Stop AI" : "Start AI"}
                </button>
                
                {aiInterviewerActive && (
                  <div className="ai-status">
                    <span className={`status-indicator ${aiInterviewerStatus}`}>
                      {aiInterviewerStatus === 'speaking' ? "🗣️ Speaking" : 
                      aiInterviewerStatus === 'listening' ? "👂 Listening" :
                      aiInterviewerStatus === 'analyzing' ? "🔍 Analyzing" : 
                      aiInterviewerStatus === 'complete' ? "✅ Complete" :
                      aiInterviewerStatus === 'connected' ? "Connected" : "Ready"}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
          
          <GenerateReportButton />
          <div className="room-id"><span>Room ID:</span><span className="room-id-value">{room.id}</span></div>
          <button className="copy-room-id-button" onClick={copyRoomId}>Copy Room ID</button>
          <button className="leave-button" onClick={handleLeaveMeeting}>Leave Meeting</button>
        </div>
      </div>
      <div className="room-content">
        <div className="video-section">
          <div className="video-container">
            <div className={`video-grid ${isScreenSharing || isParticipantScreenSharing ? 'has-screen-share' : ''}`}>
              
              {/* INTERVIEWER VIDEO TILE */}
              <div className={`video-tile interviewer-tile ${isScreenSharing ? 'screen-share' : ''} ${interviewMode === 'ai' && aiInterviewerActive ? 'ai-agent-active' : ''}`}>
                {interviewMode === 'ai' && aiInterviewerActive ? (
                  <div className="ai-interviewer-status-panel">
                    <div className="ai-status-header">
                      <span className="ai-icon-large">🤖</span>
                      <h3>AI Interviewer Active</h3>
                      <div className={`ai-mode-badge ${aiInterviewerStatus}`}>
                        {aiInterviewerStatus === 'speaking' && 'Speaking'}
                        {aiInterviewerStatus === 'listening' && 'Listening'}
                        {aiInterviewerStatus === 'analyzing' && 'Analyzing'}
                        {aiInterviewerStatus === 'connected' && 'Connected'}
                        {aiInterviewerStatus === 'complete' && 'Complete'}
                      </div>
                    </div>
                    
                    {/* Current Question Display */}
                    <div className="current-question-panel">
                      <div className="panel-label">Current AI Question:</div>
                      <div className="question-text">
                        {currentQuestion || "Waiting for AI to generate first question..."}
                      </div>
                      {currentQuestion && (
                        <div className="question-meta-info">
                          <span>📏 {currentQuestion.split(' ').length} words</span>
                          <span>🎯 Based on participant's resume</span>
                        </div>
                      )}
                    </div>
                    
                    {/* Question History */}
                    {questionHistory.length > 0 && (
                      <div className="question-history-panel">
                        <div className="panel-label">Questions Asked ({questionHistory.length}):</div>
                        <div className="history-list">
                          {questionHistory.map((q, idx) => (
                            <div key={idx} className="history-item">
                              <span className="q-number">{idx + 1}</span>
                              <span className="q-text">{q.length > 100 ? q.substring(0, 100) + '...' : q}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {/* Resume Info */}
                    {resumeData && (
                      <div className="resume-info-panel">
                        <div className="panel-label">Resume Info:</div>
                        <div className="resume-details">
                          <span>📄 {resumeData.filename}</span>
                          <span>✓ Ready for AI interview</span>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <video
                      ref={videoRef}
                      autoPlay
                      playsInline
                      muted
                      className={`video-element ${isScreenSharing ? 'screen-share' : 'mirror-effect'} ${interviewMode === 'ai' ? 'video-hidden' : ''}`}
                    />
                    {interviewMode === 'ai' && !aiInterviewerActive && (
                      <div className="ai-mode-overlay">
                        <div className="ai-icon">🤖</div>
                        <div>AI Interviewer Ready</div>
                        <div className="ai-mode-hint">Click Start AI to begin</div>
                      </div>
                    )}
                    {!isCameraOn && !isScreenSharing && interviewMode === 'manual' && (
                      <div className="video-overlay">
                        <div className="camera-icon">📹</div>
                        <div>Your camera is off</div>
                      </div>
                    )}
                  </>
                )}
                
                <div className="video-info">
                  <div className="participant-name">
                    {interviewMode === 'ai' && aiInterviewerActive ? '🤖 AI Interviewer' : 
                     interviewMode === 'ai' ? 'AI Mode - Ready' : 'You'}
                    {isScreenSharing && ' - Screen Sharing'}
                  </div>
                  <div className="video-status">
                    {interviewMode === 'ai' && aiInterviewerActive && (
                      <span className={`ai-status-badge ${aiInterviewerStatus}`}>
                        {aiInterviewerStatus === 'speaking' && ' 🗣️ Speaking'}
                        {aiInterviewerStatus === 'listening' && ' 👂 Listening'}
                        {aiInterviewerStatus === 'analyzing' && ' 🔍 Analyzing'}
                        {aiInterviewerStatus === 'complete' && ' ✅ Complete'}
                        {aiInterviewerStatus === 'idle' && ' 🤖 Ready'}
                      </span>
                    )}
                  </div>
                </div>
                
                {isScreenSharing && (
                  <div className="screen-share-indicator">
                    <span>🖥️ You are sharing your screen</span>
                  </div>
                )}
              </div>
              
              {/* PARTICIPANT VIDEO TILE */}
              <div className={`video-tile participant-tile ${isParticipantScreenSharing ? 'screen-share' : ''}`}>
                <video
                  ref={participantVideoRef}
                  autoPlay
                  playsInline
                  className={`video-element ${isParticipantScreenSharing ? 'screen-share' : ''}`}
                />
                <div className="video-info">
                  <div className="participant-name">
                    Participant {activeParticipants > 0 && participantStream ? 
                    (isParticipantScreenSharing ? ' - Screen Sharing' : '(Live)') : '(Offline)'}
                    {aiInterviewerActive && ' 🎤 Speaking to AI'}
                    {resumeData && ' 📄'}
                  </div>
                </div>
                {activeParticipants === 0 && (
                  <div className="video-overlay">
                    <div className="camera-icon">👤</div>
                    <div>Waiting for participant to join</div>
                    <div className="room-id-hint">Share Room ID: {room.id}</div>
                  </div>
                )}
                {activeParticipants > 0 && !participantStream && (
                  <div className="video-overlay">
                    <div className="camera-icon">📹</div>
                    <div>{isConnecting ? 'Connecting to participant video...' : 'Establishing video connection...'}</div>
                  </div>
                )}
                {participantStream && participantVideoRef.current && participantVideoRef.current.readyState < 3 && (
                  <div className="video-overlay">
                    <div className="camera-icon">🔄</div>
                    <div>Loading participant video...</div>
                  </div>
                )}
                {isParticipantScreenSharing && (
                  <div className="screen-share-indicator">
                    <span>🖥️ Participant is sharing screen</span>
                  </div>
                )}
              </div>
            </div>
            
            <div className="start-interview-container">
              <button
                onClick={interviewStatus === "active" ? stopInterview : startInterview}
                disabled={isConnecting}
                className={`start-interview-button ${interviewStatus === "active" ? 'stop' : 'start'} ${isConnecting ? 'connecting' : ''}`}
              >
                <span className="start-button-icon">
                  {isConnecting ? '🔄' : (interviewStatus === "active" ? '⏹️' : '▶️')}
                </span>
                <span className="start-button-text">
                  {isConnecting ? 'Connecting...' : (interviewStatus === "active" ? "End Interview" : "Start Interview")}
                </span>
              </button>
            </div>
            
            <div className="bottom-controls">
              {interviewMode === 'ai' && aiInterviewerActive && (
                <div className="voice-activity-indicator">
                  <div className={`voice-dot ${aiInterviewerStatus === 'speaking' ? 'speaking' : ''}`}></div>
                  <div className="voice-status">
                    {aiInterviewerStatus === 'speaking' ? 'AI Speaking' : 
                     aiInterviewerStatus === 'listening' ? 'Listening for response' : 
                     aiInterviewerStatus === 'complete' ? 'Interview Complete' :
                     'Voice Ready'}
                  </div>
                </div>
              )}
              
              <button
                onClick={toggleMic}
                className={`control-button mic-button ${isMicOn ? 'active' : 'inactive'}`}
                title={isMicOn ? "Mute Microphone" : "Unmute Microphone"}
                disabled={interviewMode === 'ai' && aiInterviewerActive}
              >
                <span className="control-icon">{isMicOn ? "🎤" : "🔇"}</span>
              </button>
              <button
                onClick={toggleCamera}
                className={`control-button camera-button ${isCameraOn ? 'active' : 'inactive'}`}
                title={isCameraOn ? "Turn Off Camera" : "Turn On Camera"}
                disabled={interviewMode === 'ai' && aiInterviewerActive}
              >
                <span className="control-icon">{isCameraOn ? "📹" : "📷"}</span>
              </button>
              <button
                onClick={toggleScreenShare}
                className={`control-button share-button ${isScreenSharing ? 'active' : 'inactive'}`}
                title={isScreenSharing ? "Stop Screen Share" : "Share Screen"}
                disabled={interviewMode === 'ai' && aiInterviewerActive}
              >
                <span className="control-icon">{isScreenSharing ? "🖥️" : "📤"}</span>
              </button>
              <button
                onClick={handleCaptureReference}
                className={`control-button reference-button ${referenceFaceSet ? 'active' : 'inactive'}`}
                title={referenceFaceSet ? "Reference Face Captured" : "Capture Reference Face"}
                disabled={!activeParticipants || capturingReference || !isParticipantVideoReady()}
              >
                <span className="control-icon">{capturingReference ? "⏳" : (referenceFaceSet ? "✅" : "👤")}</span>
                {capturingReference && <span className="capturing-text">Capturing...</span>}
              </button>
              <button
                onClick={toggleChat}
                className={`control-button chat-button ${showChat ? 'active' : 'inactive'}`}
                title={showChat ? "Close Chat" : "Open Chat"}
              >
                <span className="control-icon">💬</span>
                {unreadMessages > 0 && <span className="chat-notification-badge">{unreadMessages}</span>}
              </button>
            </div>
          </div>
        </div>
        
        <div className="results-section">
          {showChat && (
            <div className="chat-container">
              <div className="chat-header">
                <h3>Chat {chatConnected ? '🟢' : '🔴'}</h3>
                <button className="close-chat" onClick={toggleChat}>×</button>
              </div>
              <div className="chat-messages" ref={chatMessagesRef}>
                {messages.length === 0 ? (
                  <div className="no-messages">No messages yet. Start a conversation!</div>
                ) : (
                  messages.map(message => (
                    <div key={message.id} className={`message ${message.sender}`}>
                      <div className="message-sender">
                        {message.sender === 'interviewer' ? 'You' : 
                        message.sender === 'ai_interviewer' ? 'AI Interviewer' : 'Participant'}
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
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder={chatConnected ? "Type a message..." : "Connecting chat..."}
                  className="message-input"
                  disabled={!chatConnected}
                />
                <button
                  onClick={sendMessage}
                  className="send-button"
                  disabled={!chatConnected || !newMessage.trim()}
                >
                  Send
                </button>
              </div>
              <div className="chat-status">
                <span className={`status-indicator ${chatConnected ? 'online' : 'offline'}`}>
                  {chatConnected ? '🟢 Chat Online' : '🔴 Chat Offline'}
                </span>
                {signalingConnected && <span className="signaling-status"> | Signaling Connected</span>}
                {syncStatus === "synced" && <span className="sync-status"> | 🔄 Mode Synced</span>}
                {syncStatus === "requested" && <span className="sync-pending-status"> | ⏳ Waiting for participant...</span>}
                {resumeData && <span className="resume-status"> | 📄 Resume Ready</span>}
                {!resumeData && <span className="resume-missing"> | ⚠️ Resume Needed</span>}
              </div>
            </div>
          )}
          
          <div className="results-container">
            <h3 className="results-title">AI Detection Results {aiConnected ? ' 🟢' : ' 🔴'}</h3>
            <div className="detection-source">
              {referenceFaceSet && <span className="verified-badge">✓ Verified</span>}
              {resumeData && <span className="resume-badge">📄 Resume</span>}
            </div>
            <div className="results-grid">
              <div className="result-item"><span className="result-label">Faces Detected</span><span className="result-value">{aiResults.faces}</span></div>
              <div className="result-item"><span className="result-label">Eye Movements</span><span className="result-value">{aiResults.eye_moves}</span></div>
              <div className="result-item"><span className="result-label">Gender</span><span className="result-value">{aiResults.gender}</span></div>
              <div className="result-item"><span className="result-label">Emotion</span><span className="result-value">{aiResults.mood}</span></div>
              <div className="result-item"><span className="result-label">Speech Detection</span><span className="result-value">{aiResults.speech ? "Detected" : "None"}</span></div>
              <div className="result-item"><span className="result-label">Lip Sync</span><span className="result-value">{aiResults.lipsync ? "Good" : "Poor"}</span></div>
              <div className="result-item"><span className="result-label">Background Voice</span><span className="result-value">{aiResults.bg_voice ? "Detected" : "None"}</span></div>
              <div className="result-item"><span className="result-label">Face Verification</span><span className="result-value">{referenceFaceSet ? "Reference Set" : "Not Set"}</span></div>
              {interviewMode === 'ai' && aiInterviewerActive && (
                <>
                  <div className="result-item"><span className="result-label">AI Status</span><span className="result-value">{aiInterviewerStatus}</span></div>
                  <div className="result-item"><span className="result-label">Questions Asked</span><span className="result-value">{questionHistory.length}</span></div>
                </>
              )}
            </div>
            {aiResults.face_alert && (
              <div className="alert-message"><strong>ALERT:</strong> {aiResults.face_alert}</div>
            )}
            <div className="debug-info">
              <small>
                Duration: {calculateDuration()} | AI: {aiConnected ? 'Connected' : 'Disconnected'} | 
                Participant: {activeParticipants > 0 ? 'Connected' : 'Disconnected'} | 
                Video: {participantStream ? 'Active' : 'Inactive'} | Status: {connectionStatus}
              </small>
            </div>
          </div>
        </div>
      </div>
      
      <ReportModal
        showReportModal={showReportModal}
        setShowReportModal={setShowReportModal}
        finalReport={finalReport}
        currentSessionId={currentSessionId}
        room={room}
        aiResults={aiResults}
        messages={messages}
        sessionStartTime={sessionStartTime}
        calculateDuration={calculateDuration}
        downloadReport={downloadReport}
        sendReportToParticipant={sendReportToParticipant}
      />
      
      {showAIConfigModal && (
        <div className="modal-overlay">
          <div className="modal-content ai-config-modal">
            <div className="modal-header">
              <h2>🤖 AI Interviewer Configuration</h2>
              <button className="close-modal" onClick={() => setShowAIConfigModal(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="config-section">
                <label>Interview Difficulty:</label>
                <select
                  value={aiInterviewerConfig.difficulty}
                  onChange={(e) =>
                    setAiInterviewerConfig((prev) => ({
                      ...prev,
                      difficulty: e.target.value
                    }))
                  }
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </div>
              <div className="config-section">
                <label>Enable Voice Questions:</label>
                <input
                  type="checkbox"
                  checked={aiInterviewerConfig.enableVoiceQuestions}
                  onChange={(e) =>
                    setAiInterviewerConfig((prev) => ({
                      ...prev,
                      enableVoiceQuestions: e.target.checked
                    }))
                  }
                />
              </div>
              <div className="config-section">
                <label>Enable Follow-up Questions:</label>
                <input
                  type="checkbox"
                  checked={aiInterviewerConfig.enableFollowUps}
                  onChange={(e) =>
                    setAiInterviewerConfig((prev) => ({
                      ...prev,
                      enableFollowUps: e.target.checked
                    }))
                  }
                />
              </div>
              <div className="config-section">
                <label>Interview Duration (minutes):</label>
                <input
                  type="number"
                  min="5"
                  max="60"
                  value={aiInterviewerConfig.duration}
                  onChange={(e) =>
                    setAiInterviewerConfig((prev) => ({
                      ...prev,
                      duration: parseInt(e.target.value) || 30
                    }))
                  }
                />
              </div>
              <div className="config-section">
                <label>Question Types:</label>
                <div className="question-types">
                  {["technical", "behavioral", "resume_based"].map((type) => (
                    <label key={type}>
                      <input
                        type="checkbox"
                        checked={aiInterviewerConfig.questionTypes.includes(type)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setAiInterviewerConfig((prev) => ({
                              ...prev,
                              questionTypes: [...prev.questionTypes, type]
                            }));
                          } else {
                            setAiInterviewerConfig((prev) => ({
                              ...prev,
                              questionTypes: prev.questionTypes.filter(t => t !== type)
                            }));
                          }
                        }}
                      />
                      {type.replace('_', ' ').toUpperCase()}
                    </label>
                  ))}
                </div>
              </div>
              <div className="config-note">
                <p><strong>Note:</strong> AI Interview requires participant to upload a resume first.</p>
                <p>Make sure participant has uploaded their resume before starting AI interview.</p>
                <p><strong>IMPORTANT:</strong> Resumes are stored by Room ID in the backend.</p>
                <p>Current Room ID: <strong>{room.id}</strong></p>
              </div>
            </div>
            <div className="modal-footer">
              <button className="cancel-button" onClick={() => {
                setShowAIConfigModal(false);
                setInterviewMode("manual");
              }}>
                Cancel
              </button>
              <button className="submit-button" onClick={handleAIConfigSubmit}>
                Save Configuration & Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default InterviewRoom;