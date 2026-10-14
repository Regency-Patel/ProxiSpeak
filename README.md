# ProxiSpeak

A Virtual Office & Proximity Interaction Space web application.

---

## Project Structure

```
Internship(Proxispeak)/
├── server/                 # Node.js backend (Express + Socket.io)
│   ├── index.js            # Server entry point (port 3001)
│   ├── test-client.js      # Socket.io connection test verification script
│   ├── package.json        # Server dependencies and scripts
│   └── package-lock.json
├── src/                    # React frontend application (Vite)
│   ├── App.jsx             # Virtual office and smooth avatar movement
│   ├── App.css             # Office styling and control HUD
│   ├── index.css
│   └── main.jsx
├── index.html
├── package.json            # Frontend & root scripts
└── README.md
```

---

## Getting Started

### 1. Running the Backend Server (Express + Socket.io)

The backend runs on **port 3001** and is configured with CORS to allow connections from the Vite frontend (`http://localhost:5173` and `http://localhost:5174`).

#### Option A: From the `server` directory
```bash
cd server
npm install        # (Already installed)
npm start          # Starts server with node index.js
# Or for auto-reload during development:
npm run dev        # Starts server with node --watch index.js
```

#### Option B: From the project root
```bash
npm run server     # Runs backend server
# Or:
npm run server:dev # Runs backend server in watch mode
```

### 2. Testing the Backend

You can test the backend in two ways:

1. **HTTP Health Check**:
   ```bash
   curl http://localhost:3001/
   ```
   Expected response:
   ```json
   {"status":"ok","message":"ProxiSpeak Backend Server is running","port":3001,"timestamp":"..."}
   ```

2. **Socket.io Connection & Disconnection Test**:
   ```bash
   cd server
   npm test
   ```
   This will run `test-client.js`, connect to `http://localhost:3001`, log the assigned socket ID, cleanly disconnect, and verify the server connection logging.

---

### 3. Running the Frontend (React + Vite)

From the project root:
```bash
npm run dev
```

Open `http://localhost:5173/` in your browser.

- Use **Arrow keys** or **WASD** to smoothly control the avatar inside the Virtual Office Floor.
- Avatar motion is bounded by the virtual office borders.
