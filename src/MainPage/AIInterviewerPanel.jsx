import React from 'react';
import './AIInterviewerPanel.css';

function AIInterviewerPanel({ 
  currentQuestion, 
  candidateResponse, 
  questionHistory, 
  responseAnalysis, 
  aiInterviewerStatus 
}) {
  // Helper to get status details
  const getStatusDetails = (status) => {
    switch(status) {
      case 'speaking':
        return { 
          color: '#9b59b6', 
          icon: '🗣️', 
          label: 'SPEAKING', 
          bgColor: '#9b59b6',
          lightBg: 'rgba(155, 89, 182, 0.15)'
        };
      case 'listening':
        return { 
          color: '#27ae60', 
          icon: '👂', 
          label: 'LISTENING', 
          bgColor: '#27ae60',
          lightBg: 'rgba(39, 174, 96, 0.15)'
        };
      case 'analyzing':
        return { 
          color: '#f39c12', 
          icon: '🔍', 
          label: 'ANALYZING', 
          bgColor: '#f39c12',
          lightBg: 'rgba(243, 156, 18, 0.15)'
        };
      case 'connected':
        return { 
          color: '#2ecc71', 
          icon: '🔌', 
          label: 'CONNECTED', 
          bgColor: '#2ecc71',
          lightBg: 'rgba(46, 204, 113, 0.15)'
        };
      case 'complete':
        return { 
          color: '#27ae60', 
          icon: '✅', 
          label: 'COMPLETE', 
          bgColor: '#27ae60',
          lightBg: 'rgba(39, 174, 96, 0.15)'
        };
      case 'error':
        return { 
          color: '#e74c3c', 
          icon: '❌', 
          label: 'ERROR', 
          bgColor: '#e74c3c',
          lightBg: 'rgba(231, 76, 60, 0.15)'
        };
      case 'starting':
        return { 
          color: '#3498db', 
          icon: '⏳', 
          label: 'STARTING...', 
          bgColor: '#3498db',
          lightBg: 'rgba(52, 152, 219, 0.15)'
        };
      default:
        return { 
          color: '#7f8c8d', 
          icon: '🤖', 
          label: 'READY', 
          bgColor: '#7f8c8d',
          lightBg: 'rgba(127, 140, 141, 0.15)'
        };
    }
  };

  const statusDetails = getStatusDetails(aiInterviewerStatus);

  return (
    <div className="ai-interviewer-panel">
      {/* Header Section */}
      <div className="panel-header">
        <div className="header-title">
          <span className="header-icon">🤖</span>
          <h2>AI Interviewer</h2>
          <span className="header-badge active">ACTIVE</span>
        </div>
        <div className={`status-chip ${aiInterviewerStatus}`} style={{ backgroundColor: statusDetails.lightBg, borderColor: statusDetails.color }}>
          <span className="status-icon" style={{ color: statusDetails.color }}>{statusDetails.icon}</span>
          <span className="status-label" style={{ color: statusDetails.color }}>{statusDetails.label}</span>
          {aiInterviewerStatus === 'speaking' && (
            <div className="speaking-waves">
              <span></span><span></span><span></span>
            </div>
          )}
          {aiInterviewerStatus === 'listening' && (
            <div className="listening-pulse"></div>
          )}
        </div>
      </div>

      {/* Status Bar */}
      <div className="status-bar">
        <div className={`status-step ${aiInterviewerStatus === 'speaking' ? 'active' : ''} ${questionHistory.length > 0 ? 'completed' : ''}`}>
          <div className="step-icon">🗣️</div>
          <div className="step-label">Speaking</div>
          {questionHistory.length > 0 && <div className="step-check">✓</div>}
        </div>
        <div className={`status-line ${aiInterviewerStatus === 'listening' || aiInterviewerStatus === 'analyzing' ? 'active' : ''}`}></div>
        <div className={`status-step ${aiInterviewerStatus === 'listening' ? 'active' : ''}`}>
          <div className="step-icon">👂</div>
          <div className="step-label">Listening</div>
        </div>
        <div className={`status-line ${aiInterviewerStatus === 'analyzing' ? 'active' : ''}`}></div>
        <div className={`status-step ${aiInterviewerStatus === 'analyzing' ? 'active' : ''}`}>
          <div className="step-icon">🔍</div>
          <div className="step-label">Analyzing</div>
        </div>
      </div>

      {/* Current Question Section */}
      {currentQuestion && (
        <div className="current-question-section">
          <div className="section-header">
            <span className="section-icon">📝</span>
            <span className="section-title">Current Question</span>
            <span className="question-badge">ACTIVE</span>
          </div>
          <div className="question-card">
            <p className="question-text">{currentQuestion}</p>
            <div className="question-meta">
              <span className="meta-item">
                <span className="meta-icon">📏</span>
                <span>{currentQuestion.split(' ').length} words</span>
              </span>
              <span className="meta-item">
                <span className="meta-icon">🎯</span>
                <span>Based on participant's resume</span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Candidate Response Section */}
      {candidateResponse && (
        <div className="response-section">
          <div className="section-header">
            <span className="section-icon">💬</span>
            <span className="section-title">Candidate Response</span>
          </div>
          <div className="response-card">
            <p className="response-text">{candidateResponse}</p>
          </div>
        </div>
      )}

      {/* Question History Section */}
      {questionHistory.length > 0 && (
        <div className="history-section">
          <div className="section-header">
            <span className="section-icon">📋</span>
            <span className="section-title">Questions Asked</span>
            <span className="history-count">{questionHistory.length}</span>
          </div>
          <div className="history-list">
            {questionHistory.map((question, index) => (
              <div 
                key={index} 
                className={`history-item ${index === questionHistory.length - 1 ? 'current' : ''}`}
              >
                <div className="history-number">{index + 1}</div>
                <div className="history-question">
                  {question.length > 80 ? question.substring(0, 80) + '...' : question}
                </div>
                {index === questionHistory.length - 1 && (
                  <div className="current-badge">Current</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Resume Info Section */}
      {responseAnalysis && (
        <div className="analysis-section">
          <div className="section-header">
            <span className="section-icon">📊</span>
            <span className="section-title">Response Analysis</span>
          </div>
          <div className="analysis-grid">
            <div className="analysis-item">
              <span className="analysis-label">Relevance</span>
              <span className="analysis-value">
                {responseAnalysis.relevance_score ? `${(responseAnalysis.relevance_score * 100).toFixed(0)}%` : 'N/A'}
              </span>
            </div>
            <div className="analysis-item">
              <span className="analysis-label">Sentiment</span>
              <span className="analysis-value">{responseAnalysis.sentiment || 'N/A'}</span>
            </div>
            <div className="analysis-item">
              <span className="analysis-label">Length</span>
              <span className="analysis-value">{responseAnalysis.length || 0} words</span>
            </div>
            <div className="analysis-item">
              <span className="analysis-label">Confidence</span>
              <span className="analysis-value">
                {responseAnalysis.confidence ? `${(responseAnalysis.confidence * 100).toFixed(0)}%` : 'N/A'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Resume Info Section */}
      <div className="resume-section">
        <div className="section-header">
          <span className="section-icon">📄</span>
          <span className="section-title">Resume Status</span>
        </div>
        <div className="resume-card">
          <span className="resume-icon">📄</span>
          <div className="resume-info">
            <div className="resume-name">Nandhini K Resume.pdf</div>
            <div className="resume-status-badge success">✓ Ready for AI interview</div>
          </div>
        </div>
      </div>

      {/* Add CSS animations */}
      <style jsx>{`
        @keyframes wave {
          0%, 100% { transform: scaleY(1); }
          50% { transform: scaleY(1.5); }
        }
        @keyframes pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(1.3); opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

export default AIInterviewerPanel;