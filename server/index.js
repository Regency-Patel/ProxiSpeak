import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

// Allowed frontend origins (Vite default: 5173, plus fallback ports / localhost regex)
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175'
];

const checkOrigin = (origin, callback) => {
  if (!origin || allowedOrigins.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    return callback(null, true);
  }
  return callback(new Error(`Origin ${origin} not allowed by CORS`));
};

// Enable CORS for Express REST routes
app.use(cors({
  origin: checkOrigin,
  credentials: true
}));

app.use(express.json());

// In-memory store for connected users: socket.id -> { id, x, y }
const users = new Map();

// Health check / welcome route
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ProxiSpeak Backend Server is running',
    port: PORT,
    activeUsers: users.size,
    timestamp: new Date().toISOString()
  });
});

// Create HTTP server and bind Socket.io
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: checkOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Socket.io connection and movement management
io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  // Send current users list and client's own ID immediately
  socket.emit('init', {
    myId: socket.id,
    users: Array.from(users.values())
  });

  // Client announces its initial position
  socket.on('user:join', (data) => {
    const user = {
      id: socket.id,
      x: typeof data?.x === 'number' ? data.x : 200,
      y: typeof data?.y === 'number' ? data.y : 180
    };
    users.set(socket.id, user);

    // Broadcast new user to other connected clients
    socket.broadcast.emit('user:joined', user);
  });

  // Client broadcasts position update
  socket.on('user:move', (data) => {
    if (typeof data?.x === 'number' && typeof data?.y === 'number') {
      const user = { id: socket.id, x: data.x, y: data.y };
      users.set(socket.id, user);

      // Broadcast position to all other connected clients
      socket.broadcast.emit('user:moved', user);
    }
  });

  // Handle client disconnection
  socket.on('disconnect', (reason) => {
    console.log(`[Socket.io] Client disconnected: ${socket.id} (Reason: ${reason})`);
    if (users.has(socket.id)) {
      users.delete(socket.id);
      socket.broadcast.emit('user:left', socket.id);
    }
  });
});

// Start HTTP server on port 3001
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` ProxiSpeak Backend running on port ${PORT}`);
  console.log(` HTTP URL: http://localhost:${PORT}`);
  console.log(` CORS allowed origins: ${allowedOrigins.join(', ')} (and local ports)`);
  console.log(`=========================================`);
});
