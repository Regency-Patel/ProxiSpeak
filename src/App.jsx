import { useState, useEffect, useRef } from 'react'
import './App.css'

const AVATAR_SIZE = 44
// Movement physics constants (in pixels per second)
const MAX_SPEED = 260
const ACCELERATION = 1800
const FRICTION = 1600

function App() {
  const officeRef = useRef(null)
  const avatarRef = useRef(null)
  const [position, setPosition] = useState({ x: 200, y: 180 })

  // Position, velocity, and key tracking refs for continuous smooth movement
  const positionRef = useRef({ x: 200, y: 180 })
  const velocityRef = useRef({ vx: 0, vy: 0 })
  const keysPressed = useRef({})
  const [activeKeys, setActiveKeys] = useState({})
  const lastTimeRef = useRef(null)
  const lastCoordUpdateRef = useRef(0)

  // Center avatar initially once officeRef dimensions are available
  useEffect(() => {
    if (officeRef.current) {
      const rect = officeRef.current.getBoundingClientRect()
      const initialX = Math.max(0, (rect.width - AVATAR_SIZE) / 2)
      const initialY = Math.max(0, (rect.height - AVATAR_SIZE) / 2)
      positionRef.current = { x: initialX, y: initialY }
      setPosition({ x: initialX, y: initialY })

      if (avatarRef.current) {
        avatarRef.current.style.transform = `translate3d(${initialX}px, ${initialY}px, 0)`
      }
    }
  }, [])

  // Smooth, delta-time game loop with velocity interpolation and boundary clamping
  useEffect(() => {
    let animationFrameId

    const updateLoop = (currentTime) => {
      if (lastTimeRef.current === null) {
        lastTimeRef.current = currentTime
      }

      // Calculate delta time in seconds, clamped to avoid huge jumps on tab switch
      const dt = Math.min((currentTime - lastTimeRef.current) / 1000, 0.05)
      lastTimeRef.current = currentTime

      const keys = keysPressed.current

      // Determine target directional input
      let inputX = 0
      let inputY = 0

      if (keys['arrowup'] || keys['w']) inputY -= 1
      if (keys['arrowdown'] || keys['s']) inputY += 1
      if (keys['arrowleft'] || keys['a']) inputX -= 1
      if (keys['arrowright'] || keys['d']) inputX += 1

      // Normalize diagonal vector to prevent faster diagonal speed
      if (inputX !== 0 && inputY !== 0) {
        inputX *= Math.SQRT1_2
        inputY *= Math.SQRT1_2
      }

      let { vx, vy } = velocityRef.current

      // Smooth acceleration towards target speed, or apply friction to decelerate
      if (inputX !== 0) {
        const targetVx = inputX * MAX_SPEED
        vx += (targetVx - vx) * Math.min(ACCELERATION * dt / MAX_SPEED, 1)
      } else {
        // Decelerate smoothly
        const sign = Math.sign(vx)
        const decel = FRICTION * dt
        if (Math.abs(vx) <= decel) {
          vx = 0
        } else {
          vx -= sign * decel
        }
      }

      if (inputY !== 0) {
        const targetVy = inputY * MAX_SPEED
        vy += (targetVy - vy) * Math.min(ACCELERATION * dt / MAX_SPEED, 1)
      } else {
        // Decelerate smoothly
        const sign = Math.sign(vy)
        const decel = FRICTION * dt
        if (Math.abs(vy) <= decel) {
          vy = 0
        } else {
          vy -= sign * decel
        }
      }

      velocityRef.current = { vx, vy }

      // Update position if there is velocity
      if (officeRef.current && (vx !== 0 || vy !== 0)) {
        const officeWidth = officeRef.current.clientWidth
        const officeHeight = officeRef.current.clientHeight
        const maxX = Math.max(0, officeWidth - AVATAR_SIZE)
        const maxY = Math.max(0, officeHeight - AVATAR_SIZE)

        let nextX = positionRef.current.x + vx * dt
        let nextY = positionRef.current.y + vy * dt

        // Hard boundary collision checks with velocity stop
        if (nextX <= 0) {
          nextX = 0
          velocityRef.current.vx = 0
        } else if (nextX >= maxX) {
          nextX = maxX
          velocityRef.current.vx = 0
        }

        if (nextY <= 0) {
          nextY = 0
          velocityRef.current.vy = 0
        } else if (nextY >= maxY) {
          nextY = maxY
          velocityRef.current.vy = 0
        }

        positionRef.current = { x: nextX, y: nextY }

        // Directly update DOM transform for 60/120Hz stutter-free hardware acceleration
        if (avatarRef.current) {
          avatarRef.current.style.transform = `translate3d(${nextX.toFixed(2)}px, ${nextY.toFixed(2)}px, 0)`
        }

        // Throttle React state update (~30fps) for the coordinate badge to avoid unnecessary full-tree re-renders
        if (currentTime - lastCoordUpdateRef.current > 33) {
          lastCoordUpdateRef.current = currentTime
          setPosition({ x: nextX, y: nextY })
        }
      }

      animationFrameId = requestAnimationFrame(updateLoop)
    }

    animationFrameId = requestAnimationFrame(updateLoop)

    return () => {
      cancelAnimationFrame(animationFrameId)
    }
  }, [])

  // Keyboard event listeners for Arrow keys and WASD
  useEffect(() => {
    const watchedKeys = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd']

    const handleKeyDown = (e) => {
      const key = e.key.toLowerCase()

      if (watchedKeys.includes(key)) {
        e.preventDefault()
        if (!keysPressed.current[key]) {
          keysPressed.current[key] = true
          setActiveKeys((prev) => ({ ...prev, [key]: true }))
        }
      }
    }

    const handleKeyUp = (e) => {
      const key = e.key.toLowerCase()

      if (watchedKeys.includes(key)) {
        keysPressed.current[key] = false
        setActiveKeys((prev) => {
          const updated = { ...prev }
          delete updated[key]
          return updated
        })
      }
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
              ref={avatarRef}
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


