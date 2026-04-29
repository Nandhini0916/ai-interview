import { createContext, useContext, useState, useMemo, useEffect } from "react";

// Create a single context for both interviewer and participant
const InterviewModeContext = createContext(null);

export function InterviewModeProvider({ children }) {
  const [interviewerMode, setInterviewerMode] = useState("manual");
  const [participantMode, setParticipantMode] = useState("manual");
  const [syncStatus, setSyncStatus] = useState("manual"); // "manual", "synced", "requested", "pending"
  
  // Function to update mode with synchronization
  const updateInterviewerMode = (mode, shouldSync = false) => {
    setInterviewerMode(mode);
    
    if (shouldSync) {
      setSyncStatus("requested");
      // The actual sync will be confirmed by WebRTC
    }
  };
  
  const updateParticipantMode = (mode) => {
    setParticipantMode(mode);
  };
  
  // Sync modes (for when interviewer changes mode)
  const syncModes = (mode) => {
    setInterviewerMode(mode);
    setParticipantMode(mode);
    setSyncStatus("synced");
    console.log(`🔄 Modes synced to: ${mode}`);
  };
  
  // FIX: Add the missing breakSync function
  const breakSync = () => {
    setSyncStatus("manual");
    console.log("🔗 Mode sync broken - independent modes");
  };
  
  // Reset sync status
  const resetSync = () => {
    setSyncStatus("manual");
  };

  // Interviewer value
  const interviewerValue = useMemo(() => ({
    mode: interviewerMode,
    setMode: updateInterviewerMode,
    isManual: interviewerMode === "manual",
    isAI: interviewerMode === "ai",
    syncMates: syncModes,  // Keep for compatibility
    syncModes: syncModes,
    resetSync: resetSync,
    breakSync: breakSync,   // ADD THIS - Critical fix
    syncStatus
  }), [interviewerMode, syncStatus]);

  // Participant value
  const participantValue = useMemo(() => ({
    mode: participantMode,
    setMode: updateParticipantMode,
    isManual: participantMode === "manual",
    isAI: participantMode === "ai",
    syncStatus,
    breakSync: breakSync,   // Also expose breakSync for participant
    syncModes: syncModes
  }), [participantMode, syncStatus]);

  return (
    <InterviewModeContext.Provider value={{
      interviewer: interviewerValue,
      participant: participantValue,
      breakSync: breakSync,  // Also expose at root level
      syncStatus
    }}>
      {children}
    </InterviewModeContext.Provider>
  );
}

// Hook for both rooms
export function useInterviewMode() {
  const context = useContext(InterviewModeContext);
  if (!context) {
    throw new Error("useInterviewMode must be used inside InterviewModeProvider");
  }
  return context;
}

// Convenience hooks for specific roles
export function useInterviewerMode() {
  const context = useInterviewMode();
  return context.interviewer;
}

export function useParticipantMode() {
  const context = useInterviewMode();
  return context.participant;
}