const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Server Configuration
const SERVER_CONFIG = {
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  MAX_IN_MEMORY_FILE_SIZE: 5 * 1024 * 1024,
  HEARTBEAT_INTERVAL: 45000, // Increased to 45 seconds
  HEARTBEAT_TIMEOUT: 15000, // 15 seconds
  CLEANUP_INTERVAL: 60000, // 60 seconds
  MAX_ROOMS: 100,
  MAX_CLIENTS_PER_ROOM: 50,
  MAX_MESSAGES_HISTORY: 100,
  FILE_RETENTION_MINUTES: 60,
  ICE_GATHERING_TIMEOUT: 10000, // 10 seconds for ICE gathering
  CONNECTION_TIMEOUT: 30000 // 30 seconds for connection establishment
};

const wss = new WebSocket.Server({ 
  port: 8082,
  clientTracking: true,
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024
  },
  maxPayload: SERVER_CONFIG.MAX_FILE_SIZE + (1024 * 1024)
});

console.log('🚀 WebRTC Signaling Server started on port 8082');
console.log(`📊 Configuration: Max file size: ${SERVER_CONFIG.MAX_FILE_SIZE / (1024 * 1024)}MB`);

const rooms = new Map();
const clients = new Map();
let clientIdCounter = 0;
const fileMetadata = new Map();
const roomLocks = new Map();

// Track connection timeouts
const connectionTimeouts = new Map();

const safeSend = (ws, message, maxRetries = 2, retryDelay = 100) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  const sendAttempt = (attempt = 0) => {
    try {
      const messageWithTimestamp = {
        ...message,
        timestamp: Date.now(),
        messageId: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      };
      
      ws.send(JSON.stringify(messageWithTimestamp), (error) => {
        if (error && attempt < maxRetries) {
          console.warn(`⚠️ Send failed (attempt ${attempt + 1}/${maxRetries}), retrying...`, error.message);
          setTimeout(() => sendAttempt(attempt + 1), retryDelay * (attempt + 1));
        } else if (error) {
          console.error('❌ Failed to send message after retries:', error);
        }
      });
      
      return true;
    } catch (error) {
      console.error('❌ Error sending message:', error.message);
      return false;
    }
  };

  return sendAttempt();
};

async function withRoomLock(roomId, operation) {
  if (!roomLocks.has(roomId)) {
    roomLocks.set(roomId, { locked: false, queue: [] });
  }
  
  const lock = roomLocks.get(roomId);
  
  return new Promise((resolve, reject) => {
    const executeOperation = async () => {
      if (lock.locked) {
        lock.queue.push(executeOperation);
        return;
      }
      
      lock.locked = true;
      try {
        const result = await operation();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        lock.locked = false;
        if (lock.queue.length > 0) {
          const nextOperation = lock.queue.shift();
          nextOperation();
        }
      }
    };
    
    executeOperation();
  });
}

function setupHeartbeat(ws, clientId) {
  let isAlive = true;
  let pingInterval = null;
  let pongTimeout = null;

  const clearTimers = () => {
    if (pingInterval) clearInterval(pingInterval);
    if (pongTimeout) clearTimeout(pongTimeout);
  };

  const schedulePing = () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    
    // Send ping
    try {
      ws.ping(() => {});
      ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
    } catch (err) {
      console.warn(`⚠️ Failed to send ping to client ${clientId}:`, err.message);
    }
    
    pongTimeout = setTimeout(() => {
      if (!isAlive) {
        console.warn(`⚠️ Client ${clientId} did not respond to ping, terminating`);
        ws.terminate();
      } else {
        isAlive = false;
        schedulePing();
      }
    }, SERVER_CONFIG.HEARTBEAT_TIMEOUT);
  };

  ws.on('pong', () => {
    isAlive = true;
    if (pongTimeout) clearTimeout(pongTimeout);
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      if (message.type === 'pong') {
        isAlive = true;
        if (pongTimeout) clearTimeout(pongTimeout);
      }
    } catch (err) {
      // Ignore parse errors for non-JSON messages
    }
  });

  ws.on('close', () => {
    clearTimers();
  });

  ws.on('error', () => {
    clearTimers();
  });

  // Start the heartbeat after connection is established
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      schedulePing();
    }
  }, 5000);
}

async function handleJoin(ws, message, clientId) {
  const { room, role, userType, userId } = message;
  const client = clients.get(ws);

  if (!room || !role) {
    safeSend(ws, { type: 'error', message: 'Room and role are required' });
    return;
  }

  if (!['interviewer', 'participant'].includes(role)) {
    safeSend(ws, { type: 'error', message: 'Invalid role. Must be interviewer or participant' });
    return;
  }

  console.log(`👤 ${role} ${clientId} joining room ${room}`);

  if (client.room && client.room !== room) {
    await handleLeaveRoom(ws, client.room);
  }

  await withRoomLock(room, async () => {
    let roomData = rooms.get(room);
    if (!roomData) {
      roomData = { 
        id: room,
        clients: [],
        createdAt: new Date().toISOString(),
        interviewer: null,
        participants: [],
        messages: [],
        files: [],
        iceCandidates: [] // Store pending ICE candidates
      };
      rooms.set(room, roomData);
      console.log(`🏠 New room created: ${room}`);
    }

    if (roomData.clients.length >= SERVER_CONFIG.MAX_CLIENTS_PER_ROOM) {
      safeSend(ws, { 
        type: 'error', 
        message: 'Room is full',
        code: 'ROOM_FULL'
      });
      return;
    }

    // Clean up stale connections
    roomData.clients = roomData.clients.filter(c => c.ws.readyState === WebSocket.OPEN);
    if (roomData.interviewer && roomData.interviewer.ws.readyState !== WebSocket.OPEN) {
      roomData.interviewer = null;
    }
    roomData.participants = roomData.participants.filter(p => p.ws.readyState === WebSocket.OPEN);

    if (role === 'interviewer') {
      if (roomData.interviewer) {
        safeSend(ws, { 
          type: 'error', 
          message: 'Interviewer already exists in this room',
          code: 'DUPLICATE_INTERVIEWER'
        });
        return;
      }
      roomData.interviewer = client;
    } else if (role === 'participant') {
      roomData.participants.push(client);
    }

    client.room = room;
    client.role = role;
    client.userType = userType || role;
    client.userId = userId || `user-${clientId}`;
    client.joinedAt = new Date().toISOString();
    
    if (!roomData.clients.find(c => c.ws === ws)) {
      roomData.clients.push(client);
    }

    console.log(`✅ ${role} ${clientId} joined room ${room}. Room now has ${roomData.clients.length} clients`);

    safeSend(ws, { 
      type: 'joined', 
      room: room,
      role: role,
      clientId: clientId,
      userId: client.userId,
      timestamp: Date.now()
    });

    // Notify other clients
    setTimeout(() => {
      roomData.clients.forEach(otherClient => {
        if (otherClient.ws !== ws && otherClient.ws.readyState === WebSocket.OPEN) {
          if (role === 'participant' && otherClient.role === 'interviewer') {
            safeSend(otherClient.ws, { 
              type: 'participant_joined',
              room: room,
              participantId: clientId,
              userId: client.userId,
              timestamp: Date.now()
            });
          } else if (role === 'interviewer' && otherClient.role === 'participant') {
            safeSend(otherClient.ws, { 
              type: 'interviewer_joined',
              room: room,
              interviewerId: clientId,
              userId: client.userId,
              timestamp: Date.now()
            });
          }
        }
      });
    }, 100);

    // Send room state to new client
    const roomState = {
      type: 'room_state',
      room: room,
      clients: roomData.clients
        .filter(c => c.ws.readyState === WebSocket.OPEN)
        .map(c => ({
          id: c.id,
          role: c.role,
          userType: c.userType,
          userId: c.userId,
          joinedAt: c.joinedAt
        })),
      files: roomData.files.filter(f => f.canDownload !== false),
      totalClients: roomData.clients.length,
      timestamp: Date.now()
    };
    
    safeSend(ws, roomState);

    // Send recent messages
    if (roomData.messages.length > 0) {
      roomData.messages.slice(-SERVER_CONFIG.MAX_MESSAGES_HISTORY).forEach(msg => {
        safeSend(ws, {
          type: 'chat',
          message: msg.message,
          sender: msg.sender,
          senderId: msg.senderId,
          senderUserId: msg.senderUserId,
          timestamp: msg.timestamp,
          room: msg.room,
          isHistory: true
        });
      });
    }

    logRoomStatus(room);
  });
}

function handleWebRTCMessage(senderWs, message, senderId) {
  const client = clients.get(senderWs);
  if (!client || !client.room) {
    console.warn(`⚠️ Client ${senderId} not in a room`);
    safeSend(senderWs, { type: 'error', message: 'You must join a room first' });
    return;
  }

  const roomData = rooms.get(client.room);
  if (!roomData) {
    console.warn(`⚠️ Room ${client.room} not found`);
    return;
  }

  console.log(`🔄 Forwarding ${message.type} from ${client.role} ${senderId} in room ${client.room}`);

  let targetClients = [];
  
  if (message.type === 'offer') {
    if (client.role === 'interviewer') {
      if (roomData.participants.length === 0) {
        console.warn('⚠️ No participants to send offer to');
        safeSend(senderWs, { type: 'warning', message: 'No participants connected yet' });
        return;
      }
      targetClients = roomData.participants;
    } else {
      console.warn(`⚠️ Offer can only be sent by interviewer`);
      safeSend(senderWs, { type: 'error', message: 'Only interviewer can send offers' });
      return;
    }
  } else if (message.type === 'answer') {
    if (client.role === 'participant') {
      if (roomData.interviewer && roomData.interviewer.ws.readyState === WebSocket.OPEN) {
        targetClients = [roomData.interviewer];
      } else {
        console.warn(`⚠️ No interviewer available to receive answer`);
        safeSend(senderWs, { type: 'error', message: 'No interviewer available' });
        return;
      }
    } else {
      console.warn(`⚠️ Answer can only be sent by participant`);
      safeSend(senderWs, { type: 'error', message: 'Only participant can send answers' });
      return;
    }
  } else if (message.type === 'ice-candidate') {
    if (client.role === 'interviewer') {
      targetClients = roomData.participants;
    } else if (client.role === 'participant') {
      if (roomData.interviewer && roomData.interviewer.ws.readyState === WebSocket.OPEN) {
        targetClients = [roomData.interviewer];
      }
    }
  } else {
    console.warn(`⚠️ Unknown WebRTC message type: ${message.type}`);
    return;
  }

  if ((message.type === 'offer' || message.type === 'answer') && !message.sdp) {
    console.warn(`⚠️ ${message.type} missing SDP`);
    safeSend(senderWs, { type: 'error', message: `${message.type} missing SDP field` });
    return;
  }

  // Store ICE candidates if remote description not set
  if (message.type === 'ice-candidate' && message.candidate) {
    const candidateKey = `${client.room}-${client.role}`;
    if (!roomData.iceCandidates) roomData.iceCandidates = [];
    roomData.iceCandidates.push({
      candidate: message.candidate,
      targetRole: targetClients[0]?.role,
      timestamp: Date.now()
    });
    
    // Clean old candidates
    roomData.iceCandidates = roomData.iceCandidates.filter(c => 
      Date.now() - c.timestamp < 30000
    );
  }

  targetClients.forEach(targetClient => {
    if (targetClient.ws.readyState === WebSocket.OPEN) {
      const forwardedMessage = {
        ...message,
        senderId: senderId,
        senderRole: client.role,
        senderUserId: client.userId,
        targetRole: targetClient.role
      };
      
      safeSend(targetClient.ws, forwardedMessage);
      console.log(`📤 Forwarded ${message.type} to ${targetClient.role}`);
    }
  });
}

function handleChatMessage(senderWs, message, senderId) {
  const client = clients.get(senderWs);
  if (!client || !client.room) {
    console.warn(`⚠️ Client ${senderId} not in a room, cannot send chat`);
    safeSend(senderWs, { type: 'error', message: 'You must join a room first' });
    return;
  }

  const roomData = rooms.get(client.room);
  if (!roomData) return;

  const messageText = message.message || message.text;
  if (!messageText || messageText.trim() === '') return;

  const truncatedMessage = messageText.length > 1000 
    ? messageText.substring(0, 1000) + '...' 
    : messageText;

  const chatMessage = {
    type: 'chat',
    message: truncatedMessage,
    sender: client.role,
    senderId: senderId,
    senderUserId: client.userId,
    timestamp: message.timestamp || Date.now(),
    room: client.room,
    fromSignaling: true
  };

  roomData.messages.push({
    ...chatMessage,
    storedAt: new Date().toISOString()
  });
  
  if (roomData.messages.length > SERVER_CONFIG.MAX_MESSAGES_HISTORY) {
    roomData.messages = roomData.messages.slice(-SERVER_CONFIG.MAX_MESSAGES_HISTORY);
  }

  let sentCount = 0;
  
  roomData.clients.forEach(targetClient => {
    if (targetClient.ws !== senderWs && targetClient.ws.readyState === WebSocket.OPEN) {
      if (safeSend(targetClient.ws, chatMessage)) {
        sentCount++;
      }
    }
  });

  safeSend(senderWs, {
    ...chatMessage,
    delivered: true,
    deliveredTo: sentCount
  });
}

function handleScreenShareState(senderWs, message, senderId) {
  const client = clients.get(senderWs);
  if (!client || !client.room) return;

  const roomData = rooms.get(client.room);
  if (!roomData) return;

  const isSharing = Boolean(message.isSharing);

  const screenMessage = {
    type: 'screen_share_state',
    isSharing: isSharing,
    role: client.role,
    senderId: senderId,
    senderUserId: client.userId,
    timestamp: Date.now(),
    room: client.room,
    fromSignaling: true
  };

  roomData.clients.forEach(targetClient => {
    if (targetClient.ws !== senderWs && targetClient.ws.readyState === WebSocket.OPEN) {
      safeSend(targetClient.ws, screenMessage);
    }
  });
}

async function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (!client || !client.room) {
    clients.delete(ws);
    return;
  }

  const roomData = rooms.get(client.room);
  if (!roomData) {
    clients.delete(ws);
    return;
  }

  console.log(`🔌 ${client.role} ${client.id} disconnected from room ${client.room}`);

  await withRoomLock(client.room, () => {
    roomData.clients = roomData.clients.filter(c => c.ws !== ws);
    
    if (client.role === 'interviewer') {
      roomData.interviewer = null;
    } else if (client.role === 'participant') {
      roomData.participants = roomData.participants.filter(p => p.ws !== ws);
    }

    // Notify remaining clients
    roomData.clients.forEach(otherClient => {
      if (otherClient.ws.readyState === WebSocket.OPEN) {
        safeSend(otherClient.ws, {
          type: 'peer_disconnected',
          role: client.role,
          senderId: client.id,
          senderUserId: client.userId,
          room: client.room,
          timestamp: Date.now(),
          reason: 'disconnected'
        });
      }
    });

    if (roomData.clients.length === 0) {
      rooms.delete(client.room);
      console.log(`🏚️ Room ${client.room} deleted (empty)`);
    } else {
      logRoomStatus(client.room);
    }

    clients.delete(ws);
  });
}

async function handleLeaveRoom(ws, roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData) return;

  const client = clients.get(ws);
  if (!client) return;

  await withRoomLock(roomId, () => {
    roomData.clients = roomData.clients.filter(c => c.ws !== ws);
    
    if (client.role === 'interviewer') {
      roomData.interviewer = null;
    } else if (client.role === 'participant') {
      roomData.participants = roomData.participants.filter(p => p.ws !== ws);
    }

    console.log(`🚪 ${client.role} ${client.id} explicitly left room ${roomId}`);
  });
}

function logRoomStatus(roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData) return;

  const status = {
    room: roomId,
    totalClients: roomData.clients.length,
    connectedClients: roomData.clients.filter(c => c.ws.readyState === WebSocket.OPEN).length,
    interviewer: roomData.interviewer ? {
      id: roomData.interviewer.id,
      userId: roomData.interviewer.userId,
      connected: roomData.interviewer.ws.readyState === WebSocket.OPEN
    } : null,
    participants: roomData.participants
      .filter(p => p.ws.readyState === WebSocket.OPEN)
      .map(p => ({ id: p.id, userId: p.userId })),
    messageHistoryCount: roomData.messages.length,
    fileCount: roomData.files.length,
    createdAt: roomData.createdAt
  };
  
  console.log('📊 Room Status:', JSON.stringify(status, null, 2));
}

wss.on('connection', (ws, req) => {
  const clientId = ++clientIdCounter;
  const clientIp = req.socket.remoteAddress;
  
  console.log(`✅ Client ${clientId} connected from ${clientIp}`);
  
  clients.set(ws, { 
    id: clientId,
    ws, 
    room: null, 
    role: null,
    userId: null,
    joinedAt: null,
    ip: clientIp,
    connectedAt: new Date().toISOString()
  });

  setupHeartbeat(ws, clientId);

  // Set connection timeout
  const connectionTimeout = setTimeout(() => {
    if (clients.get(ws) && !clients.get(ws).room) {
      console.warn(`⚠️ Client ${clientId} did not join a room within timeout, closing`);
      ws.close(1000, 'Connection timeout');
    }
  }, SERVER_CONFIG.CONNECTION_TIMEOUT);
  
  connectionTimeouts.set(ws, connectionTimeout);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      const client = clients.get(ws);
      
      console.log(`📨 [Client ${clientId}] ${message.type}`);

      switch (message.type) {
        case 'join':
          clearTimeout(connectionTimeouts.get(ws));
          connectionTimeouts.delete(ws);
          handleJoin(ws, message, clientId);
          break;

        case 'offer':
        case 'answer':
        case 'ice-candidate':
          handleWebRTCMessage(ws, message, clientId);
          break;

        case 'chat':
          handleChatMessage(ws, message, clientId);
          break;

        case 'screen_share_state':
          handleScreenShareState(ws, message, clientId);
          break;

        case 'ping':
          safeSend(ws, { type: 'pong', timestamp: Date.now() });
          break;

        case 'leave':
          if (client && client.room) {
            handleLeaveRoom(ws, client.room);
            safeSend(ws, { type: 'left', room: client.room, timestamp: Date.now() });
          }
          break;

        case 'room_status':
          if (client && client.room) {
            logRoomStatus(client.room);
            const roomData = rooms.get(client.room);
            if (roomData) {
              safeSend(ws, {
                type: 'room_status_response',
                room: client.room,
                status: {
                  clients: roomData.clients.length,
                  interviewer: !!roomData.interviewer,
                  participants: roomData.participants.length,
                  files: roomData.files.length,
                  createdAt: roomData.createdAt
                },
                timestamp: Date.now()
              });
            }
          }
          break;

        case 'request_offer':
          if (client && client.role === 'participant') {
            console.log(`📥 Participant ${clientId} requesting new offer`);
            const roomData = rooms.get(client.room);
            if (roomData && roomData.interviewer && roomData.interviewer.ws.readyState === WebSocket.OPEN) {
              safeSend(roomData.interviewer.ws, {
                type: 'offer_requested',
                participantId: clientId,
                userId: client.userId,
                timestamp: Date.now()
              });
            }
          }
          break;

        default:
          console.warn(`⚠️ Unknown message type: ${message.type}`);
      }
    } catch (error) {
      console.error('❌ Error parsing message:', error);
      safeSend(ws, { type: 'error', message: 'Invalid message format' });
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(connectionTimeouts.get(ws));
    connectionTimeouts.delete(ws);
    const client = clients.get(ws);
    if (client) {
      console.log(`🔌 Client ${client.id} disconnected (code: ${code})`);
      handleDisconnect(ws);
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for client ${clientId}:`, error);
    clearTimeout(connectionTimeouts.get(ws));
    connectionTimeouts.delete(ws);
    handleDisconnect(ws);
  });

  safeSend(ws, { 
    type: 'welcome', 
    message: 'Connected to WebRTC Signaling Server',
    clientId: clientId,
    timestamp: Date.now(),
    serverInfo: {
      version: '2.0.0',
      uptime: process.uptime(),
      totalRooms: rooms.size,
      totalClients: clients.size,
      maxFileSize: `${SERVER_CONFIG.MAX_FILE_SIZE / (1024 * 1024)}MB`
    }
  });
});

// Periodic cleanup
setInterval(() => {
  let cleanedClients = 0;
  let cleanedRooms = 0;
  
  // Clean dead clients
  clients.forEach((client, ws) => {
    if (ws.readyState !== WebSocket.OPEN) {
      handleDisconnect(ws);
      cleanedClients++;
    }
  });
  
  // Clean empty rooms
  rooms.forEach((roomData, roomId) => {
    const activeClients = roomData.clients.filter(c => c.ws.readyState === WebSocket.OPEN);
    if (activeClients.length === 0) {
      rooms.delete(roomId);
      cleanedRooms++;
      roomLocks.delete(roomId);
    } else {
      roomData.clients = activeClients;
      roomData.participants = roomData.participants.filter(p => p.ws.readyState === WebSocket.OPEN);
      if (roomData.interviewer && roomData.interviewer.ws.readyState !== WebSocket.OPEN) {
        roomData.interviewer = null;
      }
    }
  });
  
  if (cleanedClients > 0 || cleanedRooms > 0) {
    console.log(`🧹 Cleaned up ${cleanedClients} dead clients, ${cleanedRooms} empty rooms`);
  }
}, SERVER_CONFIG.CLEANUP_INTERVAL);

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  
  clients.forEach((client, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        safeSend(ws, { type: 'server_shutdown', message: 'Server is shutting down', timestamp: Date.now() });
        ws.close(1000, 'Server shutting down');
      } catch (error) {
        console.error('Error closing client connection:', error);
      }
    }
  });
  
  setTimeout(() => {
    wss.close(() => {
      console.log('✅ Signaling server shut down');
      process.exit(0);
    });
  }, 1000);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

console.log('\n✅ WebRTC Signaling Server ready!');
console.log('='.repeat(50));
console.log('📋 Server Information:');
console.log(`   - Endpoint: ws://localhost:8082`);
console.log(`   - Max file size: ${SERVER_CONFIG.MAX_FILE_SIZE / (1024 * 1024)}MB`);
console.log(`   - Heartbeat: ${SERVER_CONFIG.HEARTBEAT_INTERVAL / 1000} seconds`);
console.log(`   - Connection timeout: ${SERVER_CONFIG.CONNECTION_TIMEOUT / 1000} seconds`);
console.log('='.repeat(50));