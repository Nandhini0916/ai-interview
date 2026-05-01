// webrtc.js - Complete stable version with connection reliability fixes

export class WebRTCSignaling {
  constructor(roomId, userId, role, options = {}) {
    this.roomId = roomId;
    this.userId = userId;
    this.role = role;
    this.ws = null;
    this.peerConnection = null;
    this.dataChannels = new Map();
    this.reconnectTimeout = null;
    this.localStream = null;
    this.pendingIceCandidates = [];
    
    this.onConnectionStateChange = options.onConnectionStateChange || (() => {});
    this.onSignalingStateChange = options.onSignalingStateChange || (() => {});
    this.onIceConnectionStateChange = options.onIceConnectionStateChange || (() => {});
    this.onTrack = options.onTrack || (() => {});
    this.onMessage = options.onMessage || (() => {});
    this.onError = options.onError || (() => {});
    this.onOpen = options.onOpen || (() => {});
    this.onClose = options.onClose || (() => {});
    this.onDataChannel = options.onDataChannel || (() => {});
    this.onLocalStream = options.onLocalStream || (() => {});
    this.onParticipantJoined = options.onParticipantJoined || (() => {});
    this.onInterviewerJoined = options.onInterviewerJoined || (() => {});
    this.onPeerDisconnected = options.onPeerDisconnected || (() => {});
    
    this.config = {
      reconnectAttempts: 0,
      maxReconnectAttempts: 5,
      baseReconnectDelay: 2000,
      maxReconnectDelay: 30000,
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ],
      iceCandidatePoolSize: 10,
      iceGatheringTimeout: 10000,
      connectionTimeout: 30000
    };
    
    this.isConnected = false;
    this.isConnecting = false;
    this.hasJoinedRoom = false;
    this.isNegotiating = false;
    this.connectionEstablished = false;
    this.isReconnecting = false;
    this.isClosed = false;
    this.heartbeatInterval = null;
    this.pongTimeout = null;
    this.missedHeartbeats = 0;
    this.maxMissedHeartbeats = 3;
    this.lastHeartbeat = 0;
    this.iceGatheringComplete = false;
    this.pendingIceCandidates = [];
    this.connectionTimer = null;
  }
  
  async connect() {
    if (this.isConnecting) {
      console.warn('⚠️ Already connecting, skipping duplicate connect attempt');
      return;
    }
    
    if (this.isClosed) {
      console.warn('⚠️ Already closed, cannot reconnect');
      return;
    }
    
    this.isConnecting = true;
    console.log(`🚀 ${this.role} initiating connection to signaling server...`);
    
    return new Promise((resolve, reject) => {
      try {
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        
        const wsUrl = 'ws://localhost:8082';
        console.log(`🔗 ${this.role} connecting to signaling: ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);
        
        const connectionTimeout = setTimeout(() => {
          if (!this.isConnected && this.isConnecting && !this.isClosed) {
            console.error(`❌ ${this.role} WebSocket connection timeout`);
            this.ws?.close();
            this.isConnecting = false;
            reject(new Error('WebSocket connection timeout'));
          }
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(connectionTimeout);
          console.log(`✅ ${this.role} WebSocket connected`);
          this.isConnected = true;
          this.isConnecting = false;
          this.config.reconnectAttempts = 0;
          this.missedHeartbeats = 0;
          
          this.startHeartbeat();
          this.sendJoinMessage();
          
          this.onOpen();
          resolve(true);
        };
        
        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            
            // Handle pong to reset heartbeat counter
            if (data.type === 'pong') {
              this.missedHeartbeats = 0;
              if (this.pongTimeout) {
                clearTimeout(this.pongTimeout);
                this.pongTimeout = null;
              }
              console.log(`📡 ${this.role} received pong`);
              return;
            }
            
            console.log(`📨 ${this.role} received:`, data.type);
            this.handleSignalingMessage(data);
          } catch (error) {
            console.error('❌ Error parsing signaling message:', error);
            this.onError(error);
          }
        };
        
        this.ws.onclose = (event) => {
          clearTimeout(connectionTimeout);
          this.stopHeartbeat();
          console.log(`🔌 ${this.role} WebSocket closed:`, event.code, event.reason);
          this.isConnected = false;
          this.isConnecting = false;
          
          this.onClose(event);
          
          if (this.hasJoinedRoom && !this.isClosed && !event.wasClean) {
            console.log(`🔄 ${this.role} attempting reconnect...`);
            this.attemptReconnect();
          }
        };
        
        this.ws.onerror = (error) => {
          clearTimeout(connectionTimeout);
          console.error(`❌ ${this.role} WebSocket error:`, error);
          this.isConnecting = false;
          this.onError(error);
          reject(error);
        };
      } catch (error) {
        this.isConnecting = false;
        console.error('❌ Error creating WebSocket:', error);
        this.onError(error);
        reject(error);
      }
    });
  }
  
  startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          const pingId = Date.now();
          this.sendSignalingMessage({ type: 'ping', timestamp: pingId, id: pingId });
          this.lastHeartbeat = pingId;
          
          // Set timeout to check for pong
          if (this.pongTimeout) clearTimeout(this.pongTimeout);
          this.pongTimeout = setTimeout(() => {
            this.missedHeartbeats++;
            console.warn(`⚠️ ${this.role} missed heartbeat ${this.missedHeartbeats}/${this.maxMissedHeartbeats}`);
            
            if (this.missedHeartbeats >= this.maxMissedHeartbeats) {
              console.error(`❌ ${this.role} max missed heartbeats reached, reconnecting...`);
              this.isConnected = false;
              this.ws?.close();
              this.missedHeartbeats = 0;
            }
          }, 10000);
        } catch (err) {
          console.warn('⚠️ Failed to send ping:', err);
        }
      }
    }, 25000);
  }
  
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }
  
  sendJoinMessage() {
    const joinMessage = {
      type: 'join',
      room: this.roomId,
      role: this.role,
      userId: this.userId,
      timestamp: Date.now()
    };
    
    console.log(`📤 ${this.role} sending join message`);
    this.sendSignalingMessage(joinMessage);
  }
  
  handleSignalingMessage(data) {
    try {
      if (data.type === 'ping') {
        this.sendSignalingMessage({ type: 'pong', timestamp: Date.now(), id: data.id });
        return;
      }
      
      if (data.type === 'pong') {
        return;
      }
      
      console.log(`🔄 ${this.role} handling: ${data.type}`);
      
      switch (data.type) {
        case 'welcome':
          console.log('👋 Welcome from server');
          break;
          
        case 'joined':
          console.log('✅ Successfully joined room');
          this.hasJoinedRoom = true;
          this.connectionEstablished = true;
          break;
          
        case 'room_state':
          console.log('🏠 Room has', data.clients?.length || 0, 'clients');
          break;
          
        case 'participant_joined':
          if (this.role === 'interviewer') {
            console.log('👤 Participant joined:', data.participantId);
            this.onParticipantJoined && this.onParticipantJoined(data);
          }
          break;
          
        case 'interviewer_joined':
          if (this.role === 'participant') {
            console.log('🎯 Interviewer joined:', data.interviewerId);
            this.onInterviewerJoined && this.onInterviewerJoined(data);
          }
          break;
          
        case 'offer':
          console.log('🎯 Received offer', data.renegotiation ? '(renegotiation)' : '');
          this.handleOffer(data.sdp, data.renegotiation).catch(err => {
            console.error('❌ Error handling offer:', err);
          });
          break;
          
        case 'answer':
          console.log('✅ Received answer', data.renegotiation ? '(renegotiation)' : '');
          this.handleAnswer(data.sdp, data.renegotiation).catch(err => {
            console.error('❌ Error handling answer:', err);
          });
          break;
          
        case 'ice-candidate':
          console.log('🧊 Received ICE candidate');
          this.handleCandidate(data.candidate).catch(err => {
            console.error('❌ Error handling ICE candidate:', err);
          });
          break;
          
        case 'chat':
          data.fromSignaling = true;
          this.onMessage && this.onMessage(data);
          break;
          
        case 'screen_share_state':
          data.fromSignaling = true;
          this.onMessage && this.onMessage(data);
          break;
          
        case 'peer_disconnected':
          console.log('👋 Peer disconnected:', data.role);
          this.onPeerDisconnected && this.onPeerDisconnected(data);
          break;
          
        case 'offer_requested':
          if (this.role === 'interviewer') {
            console.log('📥 Participant requested new offer');
            if (this.peerConnection && this.peerConnection.signalingState === 'stable' && !this.isClosed) {
              this.createOffer(true).catch(console.error);
            }
          }
          break;
          
        case 'error':
          console.error('❌ Signaling error:', data.message);
          this.onError && this.onError(new Error(data.message));
          break;
          
        default:
          console.log('📨 Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('❌ Error in handleSignalingMessage:', error);
      this.onError && this.onError(error);
    }
  }
  
  async handleOffer(offer, isRenegotiation = false) {
    try {
      console.log(`🎯 ${this.role} handling offer${isRenegotiation ? ' (renegotiation)' : ''}...`);
      
      if (!offer) {
        console.error('❌ No offer provided');
        return;
      }
      
      if (!isRenegotiation || !this.peerConnection) {
        if (this.peerConnection) {
          console.log('🔄 Closing existing peer connection');
          this.peerConnection.close();
          this.peerConnection = null;
        }
        
        await this.createPeerConnection();
      }
      
      if (!this.peerConnection) {
        throw new Error('Failed to create peer connection');
      }
      
      // Set connection timer
      this.startConnectionTimer();
      
      if (this.peerConnection.signalingState !== 'stable') {
        console.log(`⚠️ Signaling state is ${this.peerConnection.signalingState}, rolling back...`);
        await this.peerConnection.setLocalDescription({ type: 'rollback' });
      }
      
      console.log('🎯 Setting remote description');
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      console.log('✅ Remote description set');
      
      this.processPendingIceCandidates();
      
      console.log('🎯 Creating answer...');
      const answer = await this.peerConnection.createAnswer();
      
      console.log('✅ Answer created');
      await this.peerConnection.setLocalDescription(answer);
      console.log('✅ Local description set');
      
      this.sendSignalingMessage({
        type: 'answer',
        sdp: answer,
        renegotiation: isRenegotiation
      });
      
      console.log('📤 Answer sent');
      this.clearConnectionTimer();
      
    } catch (error) {
      console.error('❌ Error handling offer:', error);
      this.onError && this.onError(error);
      this.clearConnectionTimer();
      
      if (this.role === 'participant' && !this.isClosed) {
        console.log('🔄 Requesting new offer...');
        setTimeout(() => {
          if (!this.isClosed) {
            this.sendSignalingMessage({
              type: 'request_offer',
              timestamp: Date.now()
            });
          }
        }, 2000);
      }
    }
  }
  
  async handleAnswer(answer, isRenegotiation = false) {
    try {
      if (!this.peerConnection) {
        console.error('❌ No peer connection to handle answer');
        throw new Error('No peer connection');
      }
      
      if (!answer) {
        console.error('❌ No answer provided');
        return;
      }
      
      console.log(`🎯 Setting remote description from answer${isRenegotiation ? ' (renegotiation)' : ''}`);
      this.startConnectionTimer();
      
      if (this.peerConnection.signalingState === 'have-local-offer') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        console.log('✅ Remote description set');
      } else if (this.peerConnection.signalingState === 'stable') {
        console.log('⚠️ Signaling state is stable, ignoring answer');
        this.clearConnectionTimer();
        return;
      } else {
        console.log(`⚠️ Unexpected signaling state: ${this.peerConnection.signalingState}`);
        await this.peerConnection.setLocalDescription({ type: 'rollback' });
        await this.createOffer(true);
        this.clearConnectionTimer();
        return;
      }
      
      this.processPendingIceCandidates();
      this.clearConnectionTimer();
      
    } catch (error) {
      console.error('❌ Error handling answer:', error);
      this.onError && this.onError(error);
      this.clearConnectionTimer();
      throw error;
    }
  }
  
  startConnectionTimer() {
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    
    this.connectionTimer = setTimeout(() => {
      console.warn(`⚠️ Connection establishment timeout for ${this.role}`);
      if (this.peerConnection && this.peerConnection.connectionState !== 'connected') {
        console.log('🔄 Restarting ICE due to timeout...');
        this.restartIce().catch(console.error);
      }
    }, this.config.connectionTimeout);
  }
  
  clearConnectionTimer() {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }
  
  async handleCandidate(candidate) {
    if (!candidate) {
      console.log('✅ All ICE candidates gathered');
      this.iceGatheringComplete = true;
      return;
    }
    
    if (!this.peerConnection) {
      console.log('⏳ Storing ICE candidate for later');
      this.pendingIceCandidates.push(candidate);
      return;
    }
    
    try {
      if (this.peerConnection.remoteDescription && this.peerConnection.remoteDescription.type) {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('✅ ICE candidate added');
      } else {
        console.log('⏳ Waiting for remote description, storing candidate');
        this.pendingIceCandidates.push(candidate);
        
        // Set timeout to clear pending candidates
        setTimeout(() => {
          if (this.pendingIceCandidates.includes(candidate)) {
            this.pendingIceCandidates = this.pendingIceCandidates.filter(c => c !== candidate);
          }
        }, 30000);
      }
    } catch (error) {
      console.warn('⚠️ Could not add ICE candidate:', error.message);
    }
  }
  
  processPendingIceCandidates() {
    if (this.pendingIceCandidates.length === 0 || !this.peerConnection || !this.peerConnection.remoteDescription) {
      return;
    }
    
    console.log(`🧊 Processing ${this.pendingIceCandidates.length} pending ICE candidates`);
    
    const candidatesToProcess = [...this.pendingIceCandidates];
    this.pendingIceCandidates = [];
    
    for (const candidate of candidatesToProcess) {
      this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
        .then(() => console.log('✅ Added pending ICE candidate'))
        .catch(err => console.warn('⚠️ Failed to add pending ICE candidate:', err.message));
    }
  }
  
  sendSignalingMessage(message) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`⚠️ ${this.role} WebSocket not connected, cannot send:`, message.type);
      return false;
    }
    
    try {
      const messageWithContext = {
        ...message,
        room: this.roomId,
        userId: this.userId,
        role: this.role,
        timestamp: Date.now()
      };
      
      this.ws.send(JSON.stringify(messageWithContext));
      console.log(`📤 ${this.role} sent:`, message.type);
      return true;
    } catch (error) {
      console.error('❌ Error sending signaling message:', error);
      this.onError && this.onError(error);
      return false;
    }
  }
  
  async createPeerConnection() {
    try {
      if (this.peerConnection) {
        console.log('🔄 Closing existing peer connection');
        this.peerConnection.close();
        this.peerConnection = null;
      }

      const configuration = {
        iceServers: this.config.iceServers,
        iceCandidatePoolSize: this.config.iceCandidatePoolSize,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      };
      
      console.log(`🎯 ${this.role} creating new PeerConnection`);
      this.peerConnection = new RTCPeerConnection(configuration);
      
      this.setupPeerConnectionEventHandlers();
      
      if (this.role === 'interviewer') {
        this.createDataChannel('chat', { 
          ordered: true,
          maxRetransmits: 3
        });
      }
      
      if (this.localStream) {
        await this.addLocalTracks();
      }
      
      console.log(`✅ ${this.role} PeerConnection created`);
      
      return this.peerConnection;
    } catch (error) {
      console.error('❌ Error creating PeerConnection:', error);
      this.onError && this.onError(error);
      throw error;
    }
  }
  
  setupPeerConnectionEventHandlers() {
    if (!this.peerConnection) return;
    
    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      console.log(`🔗 ${this.role} connection state:`, state);
      this.onConnectionStateChange && this.onConnectionStateChange(state);
      
      switch (state) {
        case 'connected':
          console.log('🎉 WebRTC connection established!');
          this.connectionEstablished = true;
          this.isReconnecting = false;
          this.clearConnectionTimer();
          break;
        case 'failed':
          console.log('🔄 Connection failed, attempting recovery...');
          if (!this.isClosed && !this.isReconnecting) {
            this.restartIce().catch(console.error);
          }
          break;
        case 'disconnected':
          console.log('🔌 Connection disconnected');
          break;
        case 'closed':
          console.log('🔒 Connection closed');
          break;
      }
    };
    
    this.peerConnection.onsignalingstatechange = () => {
      const state = this.peerConnection.signalingState;
      console.log(`📡 ${this.role} signaling state:`, state);
      this.onSignalingStateChange && this.onSignalingStateChange(state);
      
      if (state === 'stable') {
        this.isNegotiating = false;
      }
    };
    
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection.iceConnectionState;
      console.log(`🧊 ${this.role} ICE connection state:`, state);
      this.onIceConnectionStateChange && this.onIceConnectionStateChange(state);
      
      if (state === 'failed' && !this.isClosed && !this.isReconnecting) {
        console.log('🧊 ICE failed, restarting...');
        this.restartIce().catch(console.error);
      }
      
      if (state === 'connected') {
        console.log('✅ ICE connection established');
        this.clearConnectionTimer();
      }
    };
    
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`🧊 ${this.role} generated ICE candidate`);
        this.sendSignalingMessage({
          type: 'ice-candidate',
          candidate: event.candidate
        });
      } else {
        console.log(`✅ ${this.role} ICE candidate gathering complete`);
        this.iceGatheringComplete = true;
      }
    };
    
    this.peerConnection.ontrack = (event) => {
      console.log(`🎥 ${this.role} received remote track:`, event.track.kind);
      this.onTrack && this.onTrack(event);
    };
    
    this.peerConnection.ondatachannel = (event) => {
      console.log(`💬 ${this.role} received data channel:`, event.channel.label);
      this.setupDataChannel(event.channel);
      this.onDataChannel && this.onDataChannel(event.channel);
    };
    
    this.peerConnection.onnegotiationneeded = async () => {
      console.log(`🤝 ${this.role} negotiation needed`);
      
      if (this.isNegotiating) {
        console.log('⚠️ Already negotiating, skipping');
        return;
      }
      
      if (this.isClosed) {
        console.log('⚠️ Already closed, skipping negotiation');
        return;
      }
      
      this.isNegotiating = true;
      
      try {
        await new Promise(resolve => setTimeout(resolve, 200));
        
        if (!this.peerConnection) {
          console.log('No peer connection, skipping negotiation');
          return;
        }
        
        if (this.peerConnection.signalingState === 'stable') {
          console.log(`🎯 ${this.role} creating offer for renegotiation`);
          
          const offer = await this.peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
            iceRestart: this.peerConnection.iceConnectionState === 'failed'
          });
          
          await this.peerConnection.setLocalDescription(offer);
          
          this.sendSignalingMessage({
            type: 'offer',
            sdp: offer,
            renegotiation: true
          });
          
          console.log(`✅ ${this.role} renegotiation offer sent`);
        }
      } catch (error) {
        console.error('❌ Error during negotiation:', error);
      } finally {
        setTimeout(() => {
          this.isNegotiating = false;
        }, 5000);
      }
    };
  }
  
  setupDataChannel(channel) {
    if (this.dataChannels.has(channel.label)) {
      console.log(`⚠️ Data channel ${channel.label} already exists`);
      const oldChannel = this.dataChannels.get(channel.label);
      if (oldChannel && oldChannel.readyState !== 'closed') {
        oldChannel.close();
      }
    }
    
    this.dataChannels.set(channel.label, channel);
    
    channel.onopen = () => {
      console.log(`✅ ${this.role} data channel opened:`, channel.label);
      this.onMessage && this.onMessage({ 
        type: 'data_channel_state', 
        channel: channel.label, 
        state: 'open',
        fromDataChannel: true 
      });
    };
    
    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        data.fromDataChannel = true;
        data.channel = channel.label;
        console.log(`📨 ${this.role} data channel message:`, data.type);
        this.onMessage && this.onMessage(data);
      } catch (e) {
        console.error('❌ Error parsing data channel message:', e);
        this.onMessage && this.onMessage({
          type: 'chat',
          message: event.data,
          fromDataChannel: true,
          channel: channel.label,
          sender: 'unknown'
        });
      }
    };
    
    channel.onclose = () => {
      console.log(`🔌 ${this.role} data channel closed:`, channel.label);
      this.dataChannels.delete(channel.label);
      this.onMessage && this.onMessage({ 
        type: 'data_channel_state', 
        channel: channel.label, 
        state: 'closed',
        fromDataChannel: true 
      });
    };
    
    channel.onerror = (error) => {
      console.error(`❌ ${this.role} data channel error:`, error);
      this.onError && this.onError(error);
    };
  }
  
  async createOffer(iceRestart = false) {
    try {
      this.startConnectionTimer();
      
      if (!this.peerConnection) {
        console.log('🚀 Creating peer connection for offer');
        await this.createPeerConnection();
      }
      
      if (!this.peerConnection) {
        throw new Error('Failed to create peer connection');
      }
      
      console.log(`🎯 Creating offer${iceRestart ? ' with ICE restart' : ''}...`);
      
      if (this.peerConnection.signalingState !== 'stable') {
        console.warn(`⚠️ Cannot create offer, signaling state is: ${this.peerConnection.signalingState}`);
        await this.peerConnection.setLocalDescription({ type: 'rollback' });
      }
      
      const offerOptions = iceRestart ? { iceRestart: true } : {};
      const offer = await this.peerConnection.createOffer(offerOptions);
      console.log('✅ Offer created');
      
      await this.peerConnection.setLocalDescription(offer);
      console.log('✅ Local description set');
      
      this.sendSignalingMessage({
        type: 'offer',
        sdp: offer,
        iceRestart: iceRestart
      });
      
      console.log('📤 Offer sent');
      this.clearConnectionTimer();
      return offer;
    } catch (error) {
      console.error('❌ Error creating offer:', error);
      this.onError && this.onError(error);
      this.isNegotiating = false;
      this.clearConnectionTimer();
      throw error;
    }
  }
  
  sendChatMessage(messageText, messageId = null) {
    const messageIdToUse = messageId || `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = Date.now();
    
    const chatData = {
      type: 'chat',
      message: messageText,
      timestamp: timestamp,
      sender: this.role,
      id: messageIdToUse,
      fromDataChannel: true
    };
    
    console.log(`📤 ${this.role} sending chat message`);
    
    return this.sendData('chat', chatData);
  }
  
  sendData(channelLabel, data) {
    const channel = this.dataChannels.get(channelLabel);
    if (channel && channel.readyState === 'open') {
      try {
        const message = typeof data === 'string' ? data : JSON.stringify(data);
        channel.send(message);
        console.log(`📤 ${this.role} sent data on ${channelLabel}:`, data.type || 'raw data');
        return true;
      } catch (error) {
        console.error('❌ Error sending data:', error);
        return false;
      }
    } else {
      if (channelLabel === 'chat') {
        console.log(`📤 Falling back to signaling for chat message`);
        return this.sendSignalingMessage({
          type: 'chat',
          ...data
        });
      }
      console.warn(`⚠️ Data channel ${channelLabel} not open, state:`, channel?.readyState);
      return false;
    }
  }
  
  createDataChannel(label, options = {}) {
    if (!this.peerConnection) {
      console.error('❌ No peer connection to create data channel');
      return null;
    }
    
    try {
      if (this.dataChannels.has(label)) {
        console.log(`⚠️ Data channel ${label} already exists`);
        const existingChannel = this.dataChannels.get(label);
        if (existingChannel.readyState === 'open') {
          return existingChannel;
        }
        existingChannel.close();
        this.dataChannels.delete(label);
      }
      
      const channel = this.peerConnection.createDataChannel(label, {
        ordered: true,
        maxRetransmits: 3,
        ...options
      });
      
      this.setupDataChannel(channel);
      console.log(`✅ Data channel created: ${label}`);
      return channel;
    } catch (error) {
      console.error('❌ Error creating data channel:', error);
      this.onError && this.onError(error);
      return null;
    }
  }
  
  attemptReconnect() {
    if (this.isReconnecting) {
      console.log('⚠️ Already reconnecting, skipping');
      return;
    }
    
    if (this.isClosed) {
      console.log('⚠️ Already closed, skipping reconnect');
      return;
    }
    
    this.isReconnecting = true;
    
    if (this.config.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.log(`❌ Max reconnect attempts reached`);
      this.onError && this.onError(new Error('Max reconnect attempts reached'));
      this.isReconnecting = false;
      return;
    }

    this.config.reconnectAttempts++;
    const delay = Math.min(
      this.config.baseReconnectDelay * Math.pow(1.5, this.config.reconnectAttempts - 1),
      this.config.maxReconnectDelay
    );
    
    console.log(`🔄 Attempting reconnect in ${delay}ms (attempt ${this.config.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    
    this.reconnectTimeout = setTimeout(async () => {
      console.log(`🔄 Executing reconnect...`);
      try {
        if (this.peerConnection) {
          this.peerConnection.close();
          this.peerConnection = null;
        }
        
        this.dataChannels.clear();
        this.pendingIceCandidates = [];
        this.iceGatheringComplete = false;
        
        await this.connect();
        this.isReconnecting = false;
      } catch (error) {
        console.error(`❌ Reconnect failed:`, error);
        this.isReconnecting = false;
      }
    }, delay);
  }
  
  close() {
    console.log(`🛑 Closing ${this.role} WebRTC...`);
    this.isClosed = true;
    
    this.stopHeartbeat();
    this.clearConnectionTimer();
    
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    
    this.closeDataChannels();
    
    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch (error) {
        console.error('Error closing peer connection:', error);
      }
      this.peerConnection = null;
    }
    
    if (this.ws) {
      try {
        this.ws.close();
      } catch (error) {
        console.error('Error closing WebSocket:', error);
      }
      this.ws = null;
    }
    
    this.pendingIceCandidates = [];
    this.isConnected = false;
    this.isConnecting = false;
    this.hasJoinedRoom = false;
    this.isNegotiating = false;
    this.connectionEstablished = false;
    this.isReconnecting = false;
    this.config.reconnectAttempts = 0;
    
    console.log(`✅ ${this.role} WebRTC closed`);
  }
  
  closeDataChannels() {
    this.dataChannels.forEach(channel => {
      try {
        if (channel.readyState !== 'closed') {
          channel.close();
        }
      } catch (error) {
        console.error('Error closing data channel:', error);
      }
    });
    this.dataChannels.clear();
  }
  
  async setLocalStream(stream) {
    this.localStream = stream;
    
    if (stream) {
      console.log(`🎥 ${this.role} setting local stream with`, stream.getTracks().length, 'tracks');
      
      if (this.peerConnection) {
        await this.addLocalTracks();
      }
    }
    
    this.onLocalStream && this.onLocalStream(stream);
  }
  
  async addLocalTracks() {
    if (!this.peerConnection || !this.localStream) return;
    
    try {
      const existingSenders = this.peerConnection.getSenders();
      const tracksToAdd = this.localStream.getTracks();
      
      for (const track of tracksToAdd) {
        const existingSender = existingSenders.find(s => s.track?.kind === track.kind);
        if (existingSender && existingSender.track) {
          await existingSender.replaceTrack(track);
          console.log(`✅ Replaced ${track.kind} track`);
        } else {
          this.peerConnection.addTrack(track, this.localStream);
          console.log(`✅ Added ${track.kind} track`);
        }
      }
      
      console.log(`✅ ${this.role} added/replaced local tracks`);
    } catch (error) {
      console.error('❌ Error adding local tracks:', error);
    }
  }
  
  async replaceVideoTrack(newTrack) {
    if (!this.peerConnection) return;
    
    try {
      const senders = this.peerConnection.getSenders();
      const videoSender = senders.find(s => s.track && s.track.kind === 'video');
      
      if (videoSender) {
        await videoSender.replaceTrack(newTrack);
        console.log('✅ Replaced video track');
      } else if (newTrack && this.localStream) {
        this.peerConnection.addTrack(newTrack, this.localStream);
        console.log('✅ Added video track');
      }
    } catch (error) {
      console.error('❌ Error replacing video track:', error);
    }
  }
  
  async replaceAudioTrack(newTrack) {
    if (!this.peerConnection) return;
    
    try {
      const senders = this.peerConnection.getSenders();
      const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
      
      if (audioSender) {
        await audioSender.replaceTrack(newTrack);
        console.log('✅ Replaced audio track');
      } else if (newTrack && this.localStream) {
        this.peerConnection.addTrack(newTrack, this.localStream);
        console.log('✅ Added audio track');
      }
    } catch (error) {
      console.error('❌ Error replacing audio track:', error);
    }
  }
  
  async restartIce() {
    if (!this.peerConnection || this.isReconnecting) return;
    
    try {
      console.log('🔄 Restarting ICE...');
      this.isReconnecting = true;
      
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      await this.peerConnection.setLocalDescription(offer);
      
      this.sendSignalingMessage({
        type: 'offer',
        sdp: offer,
        iceRestart: true
      });
      
      console.log('✅ ICE restart initiated');
      
      setTimeout(() => {
        this.isReconnecting = false;
      }, 5000);
    } catch (error) {
      console.error('❌ Error restarting ICE:', error);
      this.isReconnecting = false;
    }
  }
  
  sendScreenShareState(isSharing) {
    const message = {
      type: 'screen_share_state',
      isSharing: isSharing,
      timestamp: Date.now()
    };
    
    this.sendData('chat', message);
    this.sendSignalingMessage(message);
  }
  
  isDataChannelOpen(channelLabel) {
    const channel = this.dataChannels.get(channelLabel);
    return channel ? channel.readyState === 'open' : false;
  }
  
  getStatus() {
    return {
      signaling: this.isConnected ? 'connected' : 'disconnected',
      peerConnection: this.peerConnection ? this.peerConnection.connectionState : 'disconnected',
      iceConnection: this.peerConnection ? this.peerConnection.iceConnectionState : 'disconnected',
      signalingState: this.peerConnection ? this.peerConnection.signalingState : 'closed',
      hasJoinedRoom: this.hasJoinedRoom,
      connectionEstablished: this.connectionEstablished,
      isReconnecting: this.isReconnecting,
      isClosed: this.isClosed,
      iceGatheringComplete: this.iceGatheringComplete,
      dataChannels: Array.from(this.dataChannels.entries()).map(([label, channel]) => ({
        label,
        state: channel.readyState
      }))
    };
  }
}

export const createWebRTCManager = (roomId, userId, role, options = {}) => {
  return new WebRTCSignaling(roomId, userId, role, options);
};

export const createDefaultWebRTCManager = (roomId, userId, role, eventHandlers = {}) => {
  return createWebRTCManager(roomId, userId, role, {
    onConnectionStateChange: (state) => {
      console.log(`🔗 ${role} connection state:`, state);
      if (eventHandlers.onConnectionStateChange) {
        eventHandlers.onConnectionStateChange(state);
      }
    },
    onIceConnectionStateChange: (state) => {
      console.log(`🧊 ${role} ICE state:`, state);
      if (eventHandlers.onIceConnectionStateChange) {
        eventHandlers.onIceConnectionStateChange(state);
      }
    },
    onTrack: (event) => {
      console.log(`🎥 ${role} received track:`, event.track.kind);
      if (eventHandlers.onTrack) {
        eventHandlers.onTrack(event);
      }
    },
    onMessage: (data) => {
      console.log(`📨 ${role} received message:`, data.type);
      if (eventHandlers.onMessage) {
        eventHandlers.onMessage(data);
      }
    },
    onError: (error) => {
      console.error(`❌ ${role} error:`, error);
      if (eventHandlers.onError) {
        eventHandlers.onError(error);
      }
    },
    onOpen: () => {
      console.log(`✅ ${role} signaling connected`);
      if (eventHandlers.onOpen) {
        eventHandlers.onOpen();
      }
    },
    onClose: (event) => {
      console.log(`🔌 ${role} signaling closed`);
      if (eventHandlers.onClose) {
        eventHandlers.onClose(event);
      }
    },
    onDataChannel: (channel) => {
      console.log(`💬 ${role} data channel:`, channel.label);
      if (eventHandlers.onDataChannel) {
        eventHandlers.onDataChannel(channel);
      }
    },
    onPeerDisconnected: (data) => {
      console.log(`👋 ${role} peer disconnected:`, data);
      if (eventHandlers.onPeerDisconnected) {
        eventHandlers.onPeerDisconnected(data);
      }
    },
    onParticipantJoined: (data) => {
      console.log(`👤 ${role} participant joined:`, data);
      if (eventHandlers.onParticipantJoined) {
        eventHandlers.onParticipantJoined(data);
      }
    },
    onInterviewerJoined: (data) => {
      console.log(`🎯 ${role} interviewer joined:`, data);
      if (eventHandlers.onInterviewerJoined) {
        eventHandlers.onInterviewerJoined(data);
      }
    },
    ...eventHandlers
  });
};

export default WebRTCSignaling;