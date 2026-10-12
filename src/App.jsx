import { useState, useEffect, useRef } from 'react'
import './App.css'

const AVATAR_SIZE = 44
const SPEED = 5

function App() {
  const officeRef = useRef(null)
  const [position, setPosition] = useState({ x: 200, y: 180 })
  const positionRef = useRef({ x: 200, y: 180 })
  const keysPressed = useRef({})
  const [activeKeys, setActiveKeys] = useState({})

  // Keep positionRef in sync
  useEffect(() => {
    positionRef.current = position
  }, [position])

  // Center avatar initially once officeRef is measured
  useEffect(() => {
    if (officeRef.current) {
      const rect = officeRef.current.getBoundingClientRect()
      const initialX = Math.max(0, Math.round((rect.width - AVATAR_SIZE) / 2))
      const initialY = Math.max(0, Math.round((rect.height - AVATAR_SIZE) / 2))
      setPosition({ x: initialX, y: initialY })
      positionRef.current = { x: initialX, y: initialY }
    }
  }, [])

  // Smooth animation frame game-loop for responsive movement & diagonal normalization
  useEffect(() => {
    let animationFrameId

    const updateMovement = () => {
      const keys = keysPressed.current
      let dx = 0
      let dy = 0

      if (keys['arrowup'] || keys['w']) dy -= SPEED
      if (keys['arrowdown'] || keys['s']) dy += SPEED
      if (keys['arrowleft'] || keys['a']) dx -= SPEED
      if (keys['arrowright'] || keys['d']) dx += SPEED

      if (dx !== 0 && dy !== 0) {
        dx *= 0.7071
        dy *= 0.7071
      }

      if ((dx !== 0 || dy !== 0) && officeRef.current) {
        const officeWidth = officeRef.current.clientWidth
        const officeHeight = officeRef.current.clientHeight

        const newX = Math.min(
          Math.max(0, positionRef.current.x + dx),
          officeWidth - AVATAR_SIZE
        )
        const newY = Math.min(
          Math.max(0, positionRef.current.y + dy),
          officeHeight - AVATAR_SIZE
        )

        if (newX !== positionRef.current.x || newY !== positionRef.current.y) {
          positionRef.current = { x: newX, y: newY }
          setPosition({ x: newX, y: newY })
        }
      }

      animationFrameId = requestAnimationFrame(updateMovement)
    }

    animationFrameId = requestAnimationFrame(updateMovement)

    return () => {
      cancelAnimationFrame(animationFrameId)
    }
  }, [])

  // Keyboard event listeners for WASD & Arrow keys
  useEffect(() => {
    const handleKeyDown = (e) => {
      const key = e.key.toLowerCase()
      const watchedKeys = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd']

      if (watchedKeys.includes(key)) {
        e.preventDefault()
        keysPressed.current[key] = true
        setActiveKeys((prev) => ({ ...prev, [key]: true }))
      }
    }

    const handleKeyUp = (e) => {
      const key = e.key.toLowerCase()
      keysPressed.current[key] = false
      setActiveKeys((prev) => {
        const updated = { ...prev }
        delete updated[key]
        return updated
      })
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  const isUpActive = activeKeys['arrowup'] || activeKeys['w']
  const isDownActive = activeKeys['arrowdown'] || activeKeys['s']
  const isLeftActive = activeKeys['arrowleft'] || activeKeys['a']
  const isRightActive = activeKeys['arrowright'] || activeKeys['d']

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="brand">
          <div className="brand-badge">Week 1</div>
          <h1>ProxiSpeak</h1>
        </div>
        <p className="app-subtitle">Virtual Office & Proximity Interaction Space</p>
      </header>

      <main className="main-content">
        <section className="office-card">
          <div className="card-header">
            <div className="office-status">
              <span className="status-dot"></span>
              <span>Virtual Office Floor</span>
            </div>
            <div className="coordinates-badge">
              Position: ({Math.round(position.x)}, {Math.round(position.y)})
            </div>
          </div>

          <div className="virtual-office-area" ref={officeRef}>
            <div className="grid-overlay"></div>

            {/* Avatar */}
            <div
              className="avatar"
              style={{
                transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
              }}
            >
              <span className="avatar-label">You</span>
              <div className="avatar-circle">
                <span className="avatar-icon">🧑‍💻</span>
                <span className="pulse-ring"></span>
              </div>
            </div>
          </div>

          <div className="controls-bar">
            <div className="controls-instruction">
              <span className="controls-icon">🎮</span>
              <span><strong>Move Avatar:</strong> Use <strong>Arrow keys</strong> or <strong>WASD</strong> to explore the office floor.</span>
            </div>
            <div className="key-hints">
              <div className="key-group">
                <span className={`key-cap ${isUpActive ? 'active' : ''}`}>W / &uarr;</span>
                <div className="key-row">
                  <span className={`key-cap ${isLeftActive ? 'active' : ''}`}>A / &larr;</span>
                  <span className={`key-cap ${isDownActive ? 'active' : ''}`}>S / &darr;</span>
                  <span className={`key-cap ${isRightActive ? 'active' : ''}`}>D / &rarr;</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <p>ProxiSpeak &bull; Keyboard Movement Enabled</p>
      </footer>
    </div>
  )
}

export default App


