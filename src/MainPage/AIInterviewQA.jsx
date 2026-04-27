import React from "react";
import "./AIInterviewQA.css";

function AIInterviewQA({
  currentQuestion,
  candidateResponse,
  setCandidateResponse,
  aiInterviewerStatus,
  onSubmitAnswer
}) {
  return (
    <div className="ai-qa-container">

      {/* AI Question */}
      <div className="ai-question-box">
        <div className="ai-label">AI Interviewer</div>
        <div className="ai-question-text">
          {currentQuestion || "Waiting for AI question..."}
        </div>
      </div>

      {/* Candidate Answer */}
      <div className="candidate-answer-box">
        <div className="candidate-label">Your Answer</div>
        <textarea
          className="candidate-answer-input"
          placeholder="Type your answer here..."
          value={candidateResponse}
          onChange={(e) => setCandidateResponse(e.target.value)}
          disabled={aiInterviewerStatus !== "listening"}
        />
      </div>

      {/* Submit */}
      <div className="answer-controls">
        <button
          className="submit-answer-button"
          disabled={
            aiInterviewerStatus !== "listening" ||
            candidateResponse.trim() === ""
          }
          onClick={onSubmitAnswer}
        >
          Submit Answer
        </button>
      </div>

    </div>
  );
}

export default AIInterviewQA;
