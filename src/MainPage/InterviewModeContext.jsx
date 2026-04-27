import { createContext, useContext, useState, useMemo, useEffect } from "react";

// Create a single context for both interviewer and participant
const InterviewModeContext = createContext(null);

export function InterviewModeProvider({ children }) {
  const [interviewerMode, setInterviewerMode] = useState("manual");
  const [participantMode, setParticipantMode] = useState("manual");
  const [syncStatus, setSyncStatus] = useState("manual"); // "manual", "synced", "pending"
  
  // Function to update mode with synchronization
  const updateInterviewerMode = (mode) => {
    setInterviewerMode(mode);
    
    // Automatically sync with participant if we're connected
    if (syncStatus === "synced") {
      // Send sync command via WebRTC (will be handled in the component)
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
    syncModes, // Function to sync with participant
    resetSync, // Function to reset sync
    syncStatus
  }), [interviewerMode, syncStatus]);

  // Participant value
  const participantValue = useMemo(() => ({
    mode: participantMode,
    setMode: updateParticipantMode,
    isManual: participantMode === "manual",
    isAI: participantMode === "ai",
    syncStatus
  }), [participantMode, syncStatus]);

  return (
    <InterviewModeContext.Provider value={{
      interviewer: interviewerValue,
      participant: participantValue
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