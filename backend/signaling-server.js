const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// Server Configuration
const SERVER_CONFIG = {
  MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
  MAX_IN_MEMORY_FILE_SIZE: 5 * 1024 * 1024, // 5MB files stored in memory
  HEARTBEAT_INTERVAL: 30000, // 30 seconds
  HEARTBEAT_TIMEOUT: 10000, // 10 seconds
  CLEANUP_INTERVAL: 30000, // 30 seconds
  MAX_ROOMS: 100,
  MAX_CLIENTS_PER_ROOM: 50,
  MAX_MESSAGES_HISTORY: 100,
  FILE_RETENTION_MINUTES: 60 // Keep files for 1 hour
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
  maxPayload: SERVER_CONFIG.MAX_FILE_SIZE + (1024 * 1024) // Add 1MB buffer
});

console.log('🚀 WebRTC Signaling Server started on port 8082');
console.log(`📊 Configuration: Max file size: ${SERVER_CONFIG.MAX_FILE_SIZE / (1024 * 1024)}MB`);

const rooms = new Map();
const clients = new Map();

let clientIdCounter = 0;

// Store uploaded files metadata (not actual file content for large files)
const fileMetadata = new Map();

// Room lock mechanism for synchronization
const roomLocks = new Map();

// Helper function for safe message sending with retry logic
const safeSend = (ws, message, maxRetries = 2, retryDelay = 100) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('⚠️ WebSocket not open, cannot send message');
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

// Room locking mechanism to prevent race conditions
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

// Enhanced heartbeat with connection monitoring
function setupHeartbeat(ws, clientId) {
  let isAlive = true;
  let pingInterval = null;
  let pongTimeout = null;

  const clearTimers = () => {
    if (pingInterval) clearInterval(pingInterval);
    if (pongTimeout) clearTimeout(pongTimeout);
  };

  const checkConnection = () => {
    if (!isAlive) {
      console.warn(`⚠️ Client ${clientId} did not respond to ping, terminating`);
      ws.terminate();
      return;
    }

    isAlive = false;
    if (safeSend(ws, { type: 'ping' })) {
      pongTimeout = setTimeout(() => {
        if (!isAlive) {
          console.warn(`⚠️ Client ${clientId} ping timeout`);
          ws.terminate();
        }
      }, SERVER_CONFIG.HEARTBEAT_TIMEOUT);
    }
  };

  ws.on('pong', () => {
    isAlive = true;
    if (pongTimeout) clearTimeout(pongTimeout);
  });

  ws.on('close', () => {
    clearTimers();
  });

  ws.on('error', () => {
    clearTimers();
  });

  setTimeout(() => {
    pingInterval = setInterval(checkConnection, SERVER_CONFIG.HEARTBEAT_INTERVAL);
  }, 5000);
}

// Enhanced join handler with better state management
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

  // Leave previous room if any
  if (client.room && client.room !== room) {
    await handleLeaveRoom(ws, client.room);
  }

  await withRoomLock(room, async () => {
    // Get or create room
    let roomData = rooms.get(room);
    if (!roomData) {
      roomData = { 
        id: room,
        clients: [],
        createdAt: new Date().toISOString(),
        interviewer: null,
        participants: [],
        messages: [],
        files: [] // Store file metadata
      };
      rooms.set(room, roomData);
      console.log(`🏠 New room created: ${room}`);
    }

    // Check room capacity
    if (roomData.clients.length >= SERVER_CONFIG.MAX_CLIENTS_PER_ROOM) {
      safeSend(ws, { 
        type: 'error', 
        message: 'Room is full',
        code: 'ROOM_FULL'
      });
      return;
    }

    // Check for duplicate interviewer
    if (role === 'interviewer') {
      if (roomData.interviewer && roomData.interviewer.ws.readyState === WebSocket.OPEN) {
        safeSend(ws, { 
          type: 'error', 
          message: 'Interviewer already exists in this room',
          code: 'DUPLICATE_INTERVIEWER'
        });
        return;
      }
      // Clean up old interviewer if disconnected
      if (roomData.interviewer && roomData.interviewer.ws.readyState !== WebSocket.OPEN) {
        console.log('🧹 Cleaning up disconnected interviewer');
        roomData.clients = roomData.clients.filter(c => c.ws !== roomData.interviewer.ws);
        roomData.participants = roomData.participants.filter(p => p.ws !== roomData.interviewer.ws);
        roomData.interviewer = null;
      }
      roomData.interviewer = client;
    } else if (role === 'participant') {
      roomData.participants.push(client);
    }

    // Update client info
    client.room = room;
    client.role = role;
    client.userType = userType || role;
    client.userId = userId || `user-${clientId}`;
    client.joinedAt = new Date().toISOString();
    
    // Add to room clients if not already there
    if (!roomData.clients.find(c => c.ws === ws)) {
      roomData.clients.push(client);
    }

    console.log(`✅ ${role} ${clientId} joined room ${room}. Room now has ${roomData.clients.length} clients`);

    // Send confirmation to joining client
    safeSend(ws, { 
      type: 'joined', 
      room: room,
      role: role,
      clientId: clientId,
      userId: client.userId,
      timestamp: Date.now()
    });

    // Notify other clients about the new joiner
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
          
          safeSend(otherClient.ws, {
            type: 'peer_joined',
            room: room,
            role: role,
            peerId: clientId,
            userId: client.userId,
            timestamp: Date.now()
          });
        }
      });
    }, 100);

    // Send current room state to the new client
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
      files: roomData.files.filter(f => f.canDownload !== false), // Send available files
      totalClients: roomData.clients.length,
      timestamp: Date.now()
    };
    
    safeSend(ws, roomState);

    // Send recent messages to new client
    if (roomData.messages.length > 0) {
      console.log(`📨 Sending ${Math.min(roomData.messages.length, SERVER_CONFIG.MAX_MESSAGES_HISTORY)} recent messages to new client`);
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

// Enhanced WebRTC message handling
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
    safeSend(senderWs, { type: 'error', message: 'Room not found' });
    return;
  }

  console.log(`🔄 Forwarding ${message.type} from ${client.role} ${senderId} in room ${client.room}`);

  let sentCount = 0;
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
      console.warn(`⚠️ Offer can only be sent by interviewer, but sent by ${client.role}`);
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
      console.warn(`⚠️ Answer can only be sent by participant, but sent by ${client.role}`);
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

  if (message.type === 'ice-candidate' && !message.candidate) {
    console.warn('⚠️ ICE candidate message missing candidate field');
    return;
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
      
      if (safeSend(targetClient.ws, forwardedMessage)) {
        sentCount++;
        console.log(`📤 Forwarded ${message.type} to ${targetClient.role} ${targetClient.id}`);
      } else {
        console.warn(`⚠️ Failed to forward ${message.type} to ${targetClient.role} ${targetClient.id}`);
      }
    }
  });

  console.log(`📤 ${message.type} forwarded to ${sentCount} clients`);
  
  if (sentCount === 0) {
    safeSend(senderWs, { 
      type: 'warning', 
      message: `No clients available to receive ${message.type}` 
    });
  }
}

// Enhanced chat message handling
function handleChatMessage(senderWs, message, senderId) {
  const client = clients.get(senderWs);
  if (!client || !client.room) {
    console.warn(`⚠️ Client ${senderId} not in a room, cannot send chat`);
    safeSend(senderWs, { type: 'error', message: 'You must join a room first' });
    return;
  }

  const roomData = rooms.get(client.room);
  if (!roomData) {
    console.warn(`⚠️ Room ${client.room} not found`);
    return;
  }

  const messageText = message.message || message.text;
  if (!messageText || messageText.trim() === '') {
    console.warn('⚠️ Empty chat message');
    return;
  }

  const truncatedMessage = messageText.length > 1000 
    ? messageText.substring(0, 1000) + '...' 
    : messageText;

  console.log(`💬 Processing chat message from ${client.role} ${senderId}: ${truncatedMessage.substring(0, 50)}...`);

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

  console.log(`💬 Chat from ${client.role} ${senderId} delivered to ${sentCount} clients via signaling`);
}

// File upload handling with memory management
async function handleFileUpload(ws, message, clientId) {
  const client = clients.get(ws);
  if (!client || !client.room) {
    console.warn(`⚠️ Client ${clientId} not in a room, cannot upload file`);
    safeSend(ws, { type: 'error', message: 'You must join a room first' });
    return;
  }

  const roomData = rooms.get(client.room);
  if (!roomData) {
    console.warn(`⚠️ Room ${client.room} not found`);
    return;
  }

  const { fileName, fileSize, fileType, fileId, action, chunk, totalChunks, chunkIndex } = message;
  
  // Validate file size
  if (fileSize > SERVER_CONFIG.MAX_FILE_SIZE) {
    console.warn(`⚠️ File too large: ${fileName} (${fileSize} bytes)`);
    safeSend(ws, { 
      type: 'error', 
      message: `File too large. Maximum size is ${SERVER_CONFIG.MAX_FILE_SIZE / (1024 * 1024)}MB`
    });
    return;
  }

  if (action === 'start') {
    console.log(`📁 Client ${clientId} starting file upload: ${fileName} (${fileSize} bytes)`);
    
    const isSmallFile = fileSize <= SERVER_CONFIG.MAX_IN_MEMORY_FILE_SIZE;
    
    const fileData = {
      fileId,
      fileName,
      fileSize,
      fileType,
      uploaderId: clientId,
      uploaderUserId: client.userId,
      uploaderRole: client.role,
      room: client.room,
      totalChunks,
      uploadedAt: new Date().toISOString(),
      status: 'uploading',
      // Store chunks in memory only for small files
      chunks: isSmallFile ? [] : null,
      chunkReceived: 0,
      canDownload: isSmallFile
    };
    
    fileMetadata.set(fileId, fileData);
    
    // Only store in room files if it's a small file that can be downloaded
    if (fileData.canDownload) {
      roomData.files.push(fileData);
    }
    
    safeSend(ws, {
      type: 'file_upload_progress',
      fileId,
      fileName,
      progress: 0,
      status: 'started',
      canDownload: fileData.canDownload
    });
    
  } else if (action === 'chunk') {
    const fileData = fileMetadata.get(fileId);
    if (!fileData) {
      console.warn(`⚠️ File ${fileId} not found for chunk upload`);
      return;
    }
    
    fileData.chunkReceived++;
    const progress = Math.round((fileData.chunkReceived / totalChunks) * 100);
    
    console.log(`📁 File ${fileName} upload progress: ${progress}% (${fileData.chunkReceived}/${totalChunks} chunks)`);
    
    // Store chunk only if we're keeping in memory (small files)
    if (fileData.chunks) {
      fileData.chunks[chunkIndex] = chunk;
    }
    
    safeSend(ws, {
      type: 'file_upload_progress',
      fileId,
      fileName,
      progress,
      status: 'uploading'
    });
    
  } else if (action === 'end') {
    const fileData = fileMetadata.get(fileId);
    if (!fileData) {
      console.warn(`⚠️ File ${fileId} not found for completion`);
      return;
    }
    
    fileData.status = 'completed';
    fileData.completedAt = new Date().toISOString();
    
    console.log(`✅ File upload completed: ${fileName} (${fileSize} bytes)`);
    
    safeSend(ws, {
      type: 'file_upload_complete',
      fileId,
      fileName,
      fileSize,
      fileType,
      status: 'completed',
      canDownload: fileData.canDownload
    });
    
    // If we didn't store chunks (large file), we can't provide download via signaling
    if (!fileData.canDownload) {
      console.log(`⚠️ Large file ${fileName} not stored for download (server-side limitation)`);
      safeSend(ws, {
        type: 'warning',
        message: 'Large file uploaded successfully but cannot be downloaded via signaling. Use direct transfer.',
        fileId,
        fileName
      });
    } else {
      // Notify other clients in the room about the new file
      roomData.clients.forEach(targetClient => {
        if (targetClient.ws !== ws && targetClient.ws.readyState === WebSocket.OPEN) {
          safeSend(targetClient.ws, {
            type: 'file_available',
            fileId,
            fileName,
            fileSize,
            fileType,
            uploaderId: clientId,
            uploaderUserId: client.userId,
            uploaderRole: client.role,
            uploadedAt: fileData.uploadedAt,
            canDownload: fileData.canDownload,
            timestamp: Date.now()
          });
        }
      });
    }
    
    // Clean up metadata after a delay (only for large files that we don't store)
    if (!fileData.canDownload) {
      setTimeout(() => {
        fileMetadata.delete(fileId);
        console.log(`🧹 Cleared metadata for large file: ${fileName}`);
      }, 5 * 60 * 1000); // 5 minutes
    }
  }
}

// File download handling
function handleFileDownload(ws, message, clientId) {
  const client = clients.get(ws);
  if (!client || !client.room) {
    console.warn(`⚠️ Client ${clientId} not in a room, cannot download file`);
    safeSend(ws, { type: 'error', message: 'You must join a room first' });
    return;
  }

  const { fileId, action, chunkIndex } = message;
  const fileData = fileMetadata.get(fileId);
  
  if (!fileData) {
    console.warn(`⚠️ File ${fileId} not found for download`);
    safeSend(ws, { type: 'error', message: 'File not found' });
    return;
  }

  if (!fileData.canDownload || !fileData.chunks) {
    console.warn(`⚠️ File ${fileData.fileName} cannot be downloaded via signaling`);
    safeSend(ws, { 
      type: 'error', 
      message: 'File too large for download via signaling. Use alternative transfer method.',
      fileId,
      fileName: fileData.fileName
    });
    return;
  }

  if (action === 'request') {
    console.log(`📥 Client ${clientId} requesting file download: ${fileData.fileName}`);
    
    safeSend(ws, {
      type: 'file_download_start',
      fileId,
      fileName: fileData.fileName,
      fileSize: fileData.fileSize,
      fileType: fileData.fileType,
      totalChunks: fileData.totalChunks,
      chunkSize: 16384 // 16KB chunks
    });
    
  } else if (action === 'get_chunk') {
    if (!fileData.chunks[chunkIndex]) {
      console.warn(`⚠️ Chunk ${chunkIndex} not found for file ${fileId}`);
      safeSend(ws, {
        type: 'error',
        message: `Chunk ${chunkIndex} not available`,
        fileId,
        chunkIndex
      });
      return;
    }
    
    safeSend(ws, {
      type: 'file_chunk',
      fileId,
      fileName: fileData.fileName,
      chunk: fileData.chunks[chunkIndex],
      chunkIndex,
      totalChunks: fileData.totalChunks
    });
    
    console.log(`📤 Sending chunk ${chunkIndex + 1}/${fileData.totalChunks} for file ${fileData.fileName}`);
  }
}

// Resume download handler
function handleResumeDownload(ws, message, clientId) {
  const client = clients.get(ws);
  if (!client || !client.room) {
    console.warn(`⚠️ Client ${clientId} not in a room, cannot request resume`);
    safeSend(ws, { type: 'error', message: 'You must join a room first' });
    return;
  }

  const { resumeId } = message;
  if (!resumeId) {
    console.warn(`⚠️ Resume ID missing from download request`);
    safeSend(ws, { type: 'error', message: 'Resume ID is required' });
    return;
  }

  const roomData = rooms.get(client.room);
  if (!roomData) {
    console.warn(`⚠️ Room ${client.room} not found`);
    return;
  }

  // Find the resume file in room files
  const resumeFile = roomData.files.find(file => 
    file.fileId === resumeId || 
    file.fileName.toLowerCase().includes('resume') ||
    (file.uploaderRole === 'participant' && file.fileType && (
      file.fileType.includes('pdf') || 
      file.fileType.includes('msword') || 
      file.fileType.includes('wordprocessingml') ||
      file.fileName.match(/\.(pdf|doc|docx|txt)$/i)
    ))
  );

  if (!resumeFile) {
    console.warn(`⚠️ Resume ${resumeId} not found`);
    safeSend(ws, { 
      type: 'resume_download_response',
      success: false,
      message: 'Resume not found in room files'
    });
    return;
  }

  console.log(`📄 Client ${clientId} requesting resume: ${resumeFile.fileName}`);

  // Trigger file download with the found file ID
  if (resumeFile.canDownload) {
    handleFileDownload(ws, {
      fileId: resumeFile.fileId,
      action: 'request'
    }, clientId);
    
    safeSend(ws, {
      type: 'resume_download_response',
      success: true,
      fileId: resumeFile.fileId,
      fileName: resumeFile.fileName,
      fileSize: resumeFile.fileSize,
      message: 'Resume download started'
    });
  } else {
    safeSend(ws, {
      type: 'resume_download_response',
      success: false,
      message: 'Resume is too large for download via signaling'
    });
  }
}

// Screen share state handling
function handleScreenShareState(senderWs, message, senderId) {
  const client = clients.get(senderWs);
  if (!client || !client.room) {
    console.warn(`⚠️ Client ${senderId} not in a room`);
    return;
  }

  const roomData = rooms.get(client.room);
  if (!roomData) {
    console.warn(`⚠️ Room ${client.room} not found`);
    return;
  }

  const isSharing = Boolean(message.isSharing);
  console.log(`🖥️ Processing screen share state from ${client.role} ${senderId}: ${isSharing}`);

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

  let sentCount = 0;
  roomData.clients.forEach(targetClient => {
    if (targetClient.ws !== senderWs && targetClient.ws.readyState === WebSocket.OPEN) {
      if (safeSend(targetClient.ws, screenMessage)) {
        sentCount++;
      }
    }
  });

  console.log(`🖥️ Screen share state from ${client.role} ${senderId}: ${isSharing} (sent to ${sentCount} clients via signaling)`);
}

// Enhanced disconnect handling
async function handleDisconnect(ws) {
  const client = clients.get(ws);
  if (!client || !client.room) {
    console.log(`🔌 Unknown client disconnected`);
    return;
  }

  const roomData = rooms.get(client.room);
  if (!roomData) {
    console.log(`🔌 Client ${client.role} ${client.id} disconnected from unknown room`);
    clients.delete(ws);
    return;
  }

  console.log(`🔌 ${client.role} ${client.id} disconnected from room ${client.room}`);

  await withRoomLock(client.room, () => {
    const wasInRoom = roomData.clients.some(c => c.ws === ws);
    roomData.clients = roomData.clients.filter(c => c.ws !== ws);
    
    if (client.role === 'interviewer') {
      roomData.interviewer = null;
    } else if (client.role === 'participant') {
      roomData.participants = roomData.participants.filter(p => p.ws !== ws);
    }

    console.log(`👋 ${client.role} ${client.id} left room ${client.room} (${roomData.clients.length} remaining)`);

    if (wasInRoom) {
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
    }

    if (roomData.clients.length === 0) {
      rooms.delete(client.room);
      console.log(`🏚️ Room ${client.room} deleted (empty)`);
    } else {
      logRoomStatus(client.room);
    }

    clients.delete(ws);
  });
}

// Helper function to leave room
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

// Enhanced room status logging
function logRoomStatus(roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData) {
    console.log(`❌ Room ${roomId} not found`);
    return;
  }

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
      .map(p => ({
        id: p.id,
        userId: p.userId
      })),
    messageHistoryCount: roomData.messages.length,
    fileCount: roomData.files.length,
    downloadableFiles: roomData.files.filter(f => f.canDownload).length,
    createdAt: roomData.createdAt
  };
  
  console.log('📊 Room Status:', JSON.stringify(status, null, 2));
}

// Enhanced connection handler
wss.on('connection', (ws, req) => {
  const clientId = ++clientIdCounter;
  const clientIp = req.socket.remoteAddress;
  const connectionTime = new Date().toISOString();
  
  console.log(`✅ Client ${clientId} connected from ${clientIp}`);
  
  clients.set(ws, { 
    id: clientId,
    ws, 
    room: null, 
    role: null,
    userId: null,
    joinedAt: null,
    ip: clientIp,
    connectedAt: connectionTime
  });

  setupHeartbeat(ws, clientId);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      const client = clients.get(ws);
      
      console.log(`📨 [Client ${clientId}${client?.room ? ` in room ${client.room}` : ''}] ${message.type}`);

      switch (message.type) {
        case 'join':
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

        case 'file_upload':
          handleFileUpload(ws, message, clientId);
          break;

        case 'file_download':
          handleFileDownload(ws, message, clientId);
          break;

        case 'resume_download_request':
          handleResumeDownload(ws, message, clientId);
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
                  downloadableFiles: roomData.files.filter(f => f.canDownload).length,
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
          console.warn(`⚠️ Unknown message type: ${message.type} from client ${clientId}`);
          safeSend(ws, { 
            type: 'error', 
            message: 'Unknown message type',
            receivedType: message.type 
          });
      }
    } catch (error) {
      console.error('❌ Error parsing message:', error);
      safeSend(ws, { 
        type: 'error', 
        message: 'Invalid message format',
        details: error.message 
      });
    }
  });

  ws.on('close', (code, reason) => {
    const client = clients.get(ws);
    if (client) {
      console.log(`🔌 ${client.role || 'Unknown'} ${client.id} disconnected (code: ${code}, reason: ${reason || 'No reason'})`);
      handleDisconnect(ws);
    }
  });

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for client ${clientId}:`, error);
    handleDisconnect(ws);
  });

  safeSend(ws, { 
    type: 'welcome', 
    message: 'Connected to WebRTC Signaling Server',
    clientId: clientId,
    timestamp: Date.now(),
    serverInfo: {
      version: '1.2.0',
      uptime: process.uptime(),
      totalRooms: rooms.size,
      totalClients: clients.size,
      maxFileSize: `${SERVER_CONFIG.MAX_FILE_SIZE / (1024 * 1024)}MB`,
      supportsFileTransfer: true,
      maxInMemoryFileSize: `${SERVER_CONFIG.MAX_IN_MEMORY_FILE_SIZE / (1024 * 1024)}MB`
    }
  });
});

// Periodic cleanup and stats logging
setInterval(() => {
  const stats = {
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    totalRooms: rooms.size,
    totalClients: clients.size,
    connectedClients: Array.from(clients.values()).filter(c => c.ws.readyState === WebSocket.OPEN).length,
    totalFiles: fileMetadata.size,
    rooms: Array.from(rooms.entries()).map(([roomId, room]) => ({
      roomId,
      clientCount: room.clients.length,
      connectedClientCount: room.clients.filter(c => c.ws.readyState === WebSocket.OPEN).length,
      hasInterviewer: !!room.interviewer,
      interviewerConnected: room.interviewer ? room.interviewer.ws.readyState === WebSocket.OPEN : false,
      participantCount: room.participants.length,
      fileCount: room.files.length,
      downloadableFileCount: room.files.filter(f => f.canDownload).length,
      createdAt: room.createdAt,
      ageMinutes: Math.floor((Date.now() - new Date(room.createdAt).getTime()) / 60000)
    }))
  };
  
  console.log('📈 Server Statistics:', JSON.stringify(stats, null, 2));
  
  let cleanedClients = 0;
  let cleanedRooms = 0;
  let cleanedFiles = 0;
  
  // Clean dead clients
  clients.forEach((client, ws) => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`🧹 Cleaning up dead connection: ${client.role || 'Unknown'} ${client.id}`);
      handleDisconnect(ws);
      cleanedClients++;
    }
  });
  
  // Clean empty rooms
  rooms.forEach((roomData, roomId) => {
    const activeClients = roomData.clients.filter(c => c.ws.readyState === WebSocket.OPEN);
    if (activeClients.length === 0) {
      console.log(`🧹 Cleaning up empty room: ${roomId}`);
      rooms.delete(roomId);
      cleanedRooms++;
      
      // Also clean up room lock
      roomLocks.delete(roomId);
    } else {
      roomData.clients = activeClients;
      roomData.participants = roomData.participants.filter(p => p.ws.readyState === WebSocket.OPEN);
      if (roomData.interviewer && roomData.interviewer.ws.readyState !== WebSocket.OPEN) {
        roomData.interviewer = null;
      }
    }
  });
  
  // Clean up old files (older than retention period)
  const retentionTime = Date.now() - (SERVER_CONFIG.FILE_RETENTION_MINUTES * 60 * 1000);
  fileMetadata.forEach((fileData, fileId) => {
    if (new Date(fileData.uploadedAt).getTime() < retentionTime) {
      console.log(`🧹 Cleaning up old file: ${fileData.fileName}`);
      fileMetadata.delete(fileId);
      cleanedFiles++;
    }
  });
  
  // Clean up old room locks
  const activeRoomIds = new Set(rooms.keys());
  roomLocks.forEach((lock, roomId) => {
    if (!activeRoomIds.has(roomId)) {
      roomLocks.delete(roomId);
    }
  });
  
  if (cleanedClients > 0 || cleanedRooms > 0 || cleanedFiles > 0) {
    console.log(`🧹 Cleaned up ${cleanedClients} dead clients, ${cleanedRooms} empty rooms, and ${cleanedFiles} old files`);
  }
}, SERVER_CONFIG.CLEANUP_INTERVAL);

// Graceful shutdown
const gracefulShutdown = (signal) => {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);
  
  // Send shutdown notice to all clients
  const shutdownPromises = [];
  clients.forEach((client, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      shutdownPromises.push(
        new Promise((resolve) => {
          try {
            safeSend(ws, { 
              type: 'server_shutdown', 
              message: 'Server is shutting down',
              timestamp: Date.now(),
              signal: signal
            });
            
            // Give clients time to process the message
            setTimeout(() => {
              try {
                ws.close(1000, 'Server shutting down');
                resolve();
              } catch (error) {
                console.error('Error closing client connection:', error);
                resolve();
              }
            }, 500);
          } catch (error) {
            console.error('Error sending shutdown message:', error);
            resolve();
          }
        })
      );
    }
  });
  
  // Wait for all clients to be notified
  Promise.all(shutdownPromises)
    .then(() => {
      console.log('🔒 All client connections closed');
      
      // Close the server
      wss.close(() => {
        console.log('✅ Signaling server shut down gracefully');
        process.exit(0);
      });
      
      // Force exit after 5 seconds if server doesn't close
      setTimeout(() => {
        console.warn('⚠️ Forcing exit after timeout');
        process.exit(1);
      }, 5000);
    })
    .catch(error => {
      console.error('❌ Error during graceful shutdown:', error);
      process.exit(1);
    });
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

process.on('uncaughtException', (error) => {
  console.error('💥 Uncaught Exception:', error);
  console.error('Stack trace:', error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
});

console.log('\n✅ WebRTC Signaling Server ready!');
console.log('='.repeat(50));
console.log('📋 Server Information:');
console.log(`   - Endpoint: ws://localhost:8082`);
console.log(`   - Max file size: ${SERVER_CONFIG.MAX_FILE_SIZE / (1024 * 1024)}MB`);
console.log(`   - Max in-memory file: ${SERVER_CONFIG.MAX_IN_MEMORY_FILE_SIZE / (1024 * 1024)}MB`);
console.log(`   - Heartbeat: ${SERVER_CONFIG.HEARTBEAT_INTERVAL / 1000} seconds`);
console.log(`   - Cleanup interval: ${SERVER_CONFIG.CLEANUP_INTERVAL / 1000} seconds`);
console.log(`   - File retention: ${SERVER_CONFIG.FILE_RETENTION_MINUTES} minutes`);
console.log('\n📋 Supported Message Types:');
console.log('   - join: Join a room as interviewer/participant');
console.log('   - offer/answer/ice-candidate: WebRTC signaling');
console.log('   - chat: Text messages');
console.log('   - file_upload: Upload files to room');
console.log('   - file_download: Download files from room');
console.log('   - resume_download_request: Request resume download');
console.log('   - screen_share_state: Screen sharing status');
console.log('   - ping/pong: Connection heartbeat');
console.log('   - leave: Leave current room');
console.log('   - room_status: Get room status');
console.log('   - request_offer: Participant can request new offer');
console.log('\n🔧 Features:');
console.log('   - File upload/download support with size limits');
console.log('   - Automatic reconnection handling');
console.log('   - Message history for new joiners');
console.log('   - Duplicate connection prevention');
console.log('   - Connection monitoring with heartbeats');
console.log('   - Graceful shutdown handling');
console.log('   - Room locking for race condition prevention');
console.log('   - Memory-efficient file handling');
console.log('='.repeat(50));