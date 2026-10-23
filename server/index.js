import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import User from './models/User.js';

// Resolve directory name in ESM and load environment variables from server/.env
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI;

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

// Sensible DB write throttle for position updates (e.g., 1000ms per user)
const DB_WRITE_THROTTLE_MS = 1000;
const lastDbWriteTime = new Map(); // socket.id -> timestamp
const moveWriteTimeouts = new Map(); // socket.id -> timeoutId

/**
 * Persist user position coordinates [x, y] to MongoDB safely
 */
function persistUserPosition(userId, x, y) {
  User.findOneAndUpdate(
    { userId },
    {
      $set: {
        location: {
          type: 'Point',
          coordinates: [x, y],
        },
        lastActive: new Date(),
      },
    }
  ).catch((err) => {
    console.error(`[Database Error] Failed to persist position update (${userId}):`, err.message);
  });
}

/**
 * Queue or throttle MongoDB writes during continuous movement
 * Broadcasts remain real-time while DB writes are rate-limited with trailing execution
 */
function queueUserPositionUpdate(userId, x, y) {
  const now = Date.now();
  const lastWrite = lastDbWriteTime.get(userId) || 0;

  if (now - lastWrite >= DB_WRITE_THROTTLE_MS) {
    if (moveWriteTimeouts.has(userId)) {
      clearTimeout(moveWriteTimeouts.get(userId));
      moveWriteTimeouts.delete(userId);
    }
    lastDbWriteTime.set(userId, now);
    persistUserPosition(userId, x, y);
  } else if (!moveWriteTimeouts.has(userId)) {
    const remainingTime = DB_WRITE_THROTTLE_MS - (now - lastWrite);
    const timeoutId = setTimeout(() => {
      moveWriteTimeouts.delete(userId);
      lastDbWriteTime.set(userId, Date.now());
      const currentUser = users.get(userId);
      if (currentUser) {
        persistUserPosition(userId, currentUser.x, currentUser.y);
      }
    }, remainingTime);
    moveWriteTimeouts.set(userId, timeoutId);
  }
}

// Health check / welcome route
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'ProxiSpeak Backend Server is running',
    port: PORT,
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    activeUsers: users.size,
    timestamp: new Date().toISOString()
  });
});

// Endpoint to inspect persisted users in MongoDB
app.get('/api/users', async (req, res) => {
  try {
    const persistedUsers = await User.find({}).sort({ updatedAt: -1 }).limit(50);
    res.json({
      success: true,
      count: persistedUsers.length,
      users: persistedUsers,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
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

    // MongoDB Persistence: Upsert user document with initial [x, y] position
    User.findOneAndUpdate(
      { userId: socket.id },
      {
        $set: {
          userId: socket.id,
          location: {
            type: 'Point',
            coordinates: [user.x, user.y],
          },
          isActive: true,
          lastActive: new Date(),
        },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).catch((err) => {
      console.error(`[Database Error] Failed to persist user join (${socket.id}):`, err.message);
    });
  });

  // Client broadcasts position update
  socket.on('user:move', (data) => {
    if (typeof data?.x === 'number' && typeof data?.y === 'number') {
      const user = { id: socket.id, x: data.x, y: data.y };
      users.set(socket.id, user);

      // Broadcast position to all other connected clients immediately (zero delay)
      socket.broadcast.emit('user:moved', user);

      // Persist position to MongoDB with throttling
      queueUserPositionUpdate(socket.id, user.x, user.y);
    }
  });

  // Handle client disconnection
  socket.on('disconnect', (reason) => {
    console.log(`[Socket.io] Client disconnected: ${socket.id} (Reason: ${reason})`);
    
    let lastKnownPos = null;
    if (users.has(socket.id)) {
      const u = users.get(socket.id);
      lastKnownPos = [u.x, u.y];
      users.delete(socket.id);
      socket.broadcast.emit('user:left', socket.id);
    }

    // Clear any pending throttled move timer
    if (moveWriteTimeouts.has(socket.id)) {
      clearTimeout(moveWriteTimeouts.get(socket.id));
      moveWriteTimeouts.delete(socket.id);
    }
    lastDbWriteTime.delete(socket.id);

    // MongoDB Persistence: Mark user inactive and record lastActive & final position
    const updateFields = {
      isActive: false,
      lastActive: new Date(),
    };
    if (lastKnownPos) {
      updateFields.location = {
        type: 'Point',
        coordinates: lastKnownPos,
      };
    }

    User.findOneAndUpdate(
      { userId: socket.id },
      { $set: updateFields }
    ).catch((err) => {
      console.error(`[Database Error] Failed to mark user inactive (${socket.id}):`, err.message);
    });
  });
});

// MongoDB connection event listeners for runtime monitoring
mongoose.connection.on('error', (err) => {
  console.error(`[Database Error] MongoDB runtime error: ${err.message}`);
});

mongoose.connection.on('disconnected', () => {
  console.warn('[Database Warning] MongoDB disconnected.');
});

// Start Express and Socket.io server only after MongoDB connects successfully
async function startServer() {
  if (!MONGODB_URI) {
    console.error('\n❌ [MongoDB Error] MONGODB_URI is not defined in server/.env');
    console.error('👉 Please copy server/.env.example to server/.env and configure your MongoDB connection string.');
    console.error('   Example: MONGODB_URI=mongodb://localhost:27017/proxispeak\n');
    process.exit(1);
  }

  try {
    console.log('[Database] Connecting to MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('[Database] Connected to MongoDB successfully.');

    server.listen(PORT, () => {
      console.log(`=========================================`);
      console.log(` ProxiSpeak Backend running on port ${PORT}`);
      console.log(` HTTP URL: http://localhost:${PORT}`);
      console.log(` Database: Connected`);
      console.log(` CORS allowed origins: ${allowedOrigins.join(', ')} (and local ports)`);
      console.log(`=========================================`);
    });
  } catch (error) {
    console.error('\n❌ [Database Error] Failed to connect to MongoDB:');
    console.error(`   ${error.message}\n`);
    console.error('👉 Ensure MongoDB is running and your connection string in server/.env is valid.\n');
    process.exit(1);
  }
}

startServer();

