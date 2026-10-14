import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

// Allowed frontend origins (Vite default: 5173, plus 5174 fallback)
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174'
];

// Enable CORS for Express REST routes
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true
}));

app.use(express.json());

// Health check / welcome route
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ProxiSpeak Backend Server is running',
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

// Create HTTP server and bind Socket.io
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Socket.io connection logging
io.on('connection', (socket) => {
  console.log(`[Socket.io] Client connected: ${socket.id}`);

  socket.on('disconnect', (reason) => {
    console.log(`[Socket.io] Client disconnected: ${socket.id} (Reason: ${reason})`);
  });
});

// Start HTTP server on port 3001
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` ProxiSpeak Backend running on port ${PORT}`);
  console.log(` HTTP URL: http://localhost:${PORT}`);
  console.log(` CORS allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`=========================================`);
});
