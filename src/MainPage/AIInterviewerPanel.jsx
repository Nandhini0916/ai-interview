import React from 'react';

function AIInterviewerPanel({ 
  currentQuestion, 
  candidateResponse, 
  questionHistory, 
  responseAnalysis, 
  aiInterviewerStatus 
}) {
  return (
    <div className="ai-interviewer-panel">
      <h3>🤖 AI Interviewer Panel</h3>
      
      <div className="ai-status-display">
        <div className={`ai-status-item ${aiInterviewerStatus === 'speaking' ? 'active' : ''}`}>
          {aiInterviewerStatus === 'speaking' ? '🗣️ Speaking' : '🗣️'}
        </div>
        <div className={`ai-status-item ${aiInterviewerStatus === 'listening' ? 'active' : ''}`}>
          {aiInterviewerStatus === 'listening' ? '👂 Listening' : '👂'}
        </div>
        <div className={`ai-status-item ${aiInterviewerStatus === 'analyzing' ? 'active' : ''}`}>
          {aiInterviewerStatus === 'analyzing' ? '🔍 Analyzing' : '🔍'}
        </div>
      </div>
      
      {currentQuestion && (
        <div className="current-question-box">
          <h4>Current Question:</h4>
          <p className="current-question-text">{currentQuestion}</p>
        </div>
      )}
      
      {candidateResponse && (
        <div className="candidate-response-box">
          <h4>Candidate Response:</h4>
          <p className="candidate-response-text">{candidateResponse}</p>
        </div>
      )}
      
      {questionHistory.length > 0 && (
        <div className="question-history">
          <h4>Question History:</h4>
          <ul className="question-list">
            {questionHistory.map((question, index) => (
              <li 
                key={index} 
                className={`question-item ${index === questionHistory.length - 1 ? 'current' : ''}`}
              >
                Q{index + 1}: {question}
              </li>
            ))}
          </ul>
        </div>
      )}
      
      {responseAnalysis && (
        <div className="response-analysis-box">
          <h4>Response Analysis:</h4>
          <div className="analysis-metrics">
            <div className="analysis-metric">
              <span className="metric-label">Relevance:</span>
              <span className="metric-value">
                {responseAnalysis.relevance_score ? `${(responseAnalysis.relevance_score * 100).toFixed(0)}%` : 'N/A'}
              </span>
            </div>
            <div className="analysis-metric">
              <span className="metric-label">Sentiment:</span>
              <span className="metric-value">{responseAnalysis.sentiment || 'N/A'}</span>
            </div>
            <div className="analysis-metric">
              <span className="metric-label">Length:</span>
              <span className="metric-value">{responseAnalysis.length || 0} words</span>
            </div>
            <div className="analysis-metric">
              <span className="metric-label">Confidence:</span>
              <span className="metric-value">
                {responseAnalysis.confidence ? `${(responseAnalysis.confidence * 100).toFixed(0)}%` : 'N/A'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AIInterviewerPanel;