import React from 'react'
import ReactDOM from 'react-dom/client'
import { InterviewModeProvider } from './MainPage/InterviewModeContext'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <InterviewModeProvider>
      <App />
    </InterviewModeProvider>
  </React.StrictMode>,
)