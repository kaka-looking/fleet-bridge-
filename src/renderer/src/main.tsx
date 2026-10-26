import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'
import './window-layout.css'
import './landscape-controls.css'
import './updates.css'
import './usage.css'
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
