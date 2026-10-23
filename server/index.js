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

// Proximity-based voice chat: track which user pairs are in range
const PROXIMITY_RADIUS = 150; // pixels in virtual office coordinates
const proximityPairs = new Set(); // stores "smallerId::largerId" pair keys

function getProximityKey(id1, id2) {
  return id1 < id2 ? `${id1}::${id2}` : `${id2}::${id1}`;
}

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

/**
 * Check proximity between the moved user and all other users.
 * Emits proximity:peer-nearby when entering range, proximity:peer-left when leaving.
 * The lower socket ID is designated as the WebRTC offer initiator.
 */
function checkProximity(movedUserId) {
  const movedUser = users.get(movedUserId);
  if (!movedUser) return;

  for (const [otherId, otherUser] of users) {
    if (otherId === movedUserId) continue;

    const dx = movedUser.x - otherUser.x;
    const dy = movedUser.y - otherUser.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const pairKey = getProximityKey(movedUserId, otherId);

    if (distance <= PROXIMITY_RADIUS) {
      if (!proximityPairs.has(pairKey)) {
        proximityPairs.add(pairKey);
        // Lower socket ID initiates the WebRTC offer to prevent duplicate connections
        const initiatorId = movedUserId < otherId ? movedUserId : otherId;
        io.to(movedUserId).emit('proximity:peer-nearby', {
          peerId: otherId,
          shouldInitiate: movedUserId === initiatorId,
        });
        io.to(otherId).emit('proximity:peer-nearby', {
          peerId: movedUserId,
          shouldInitiate: otherId === initiatorId,
        });
        console.log(`[Proximity] Entered range: ${movedUserId.slice(0, 5)} <-> ${otherId.slice(0, 5)} (${distance.toFixed(0)}px)`);
      }
    } else {
      if (proximityPairs.has(pairKey)) {
        proximityPairs.delete(pairKey);
        io.to(movedUserId).emit('proximity:peer-left', { peerId: otherId });
        io.to(otherId).emit('proximity:peer-left', { peerId: movedUserId });
        console.log(`[Proximity] Left range: ${movedUserId.slice(0, 5)} <-> ${otherId.slice(0, 5)} (${distance.toFixed(0)}px)`);
      }
    }
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

// Geospatial nearby user discovery endpoint using $near / $geoNear and 2dsphere index
app.get('/api/users/nearby', async (req, res) => {
  try {
    const { x, y, radius, userId } = req.query;

    // Validate presence of coordinates
    if (x === undefined || y === undefined || x === '' || y === '') {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameters: x and y coordinates are required',
      });
    }

    const parsedX = parseFloat(x);
    const parsedY = parseFloat(y);

    // Validate coordinates are numeric
    if (Number.isNaN(parsedX) || Number.isNaN(parsedY)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid coordinates: x and y must be valid numeric values',
      });
    }

    // Validate coordinates within valid GeoJSON Point bounds for 2dsphere index [-180, 180] and [-90, 90]
    if (parsedX < -180 || parsedX > 180 || parsedY < -90 || parsedY > 90) {
      return res.status(400).json({
        success: false,
        error: 'Invalid coordinates: x (longitude) must be between -180 and 180, and y (latitude) must be between -90 and 90',
      });
    }

    // Validate radius (default: 100 meters)
    let parsedRadius = 100;
    if (radius !== undefined && radius !== '') {
      parsedRadius = parseFloat(radius);
      if (Number.isNaN(parsedRadius) || parsedRadius < 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid radius: radius must be a non-negative number',
        });
      }
    }

    const requestingUserId = userId ? String(userId).trim() : null;

    // Filter to return only active users and exclude the requesting user if userId is provided
    const filterQuery = {
      isActive: true,
      ...(requestingUserId ? { userId: { $ne: requestingUserId } } : {}),
    };

    let nearbyUsers;
    try {
      // Primary: MongoDB $geoNear aggregation (performs geospatial near query and outputs distance in meters)
      nearbyUsers = await User.aggregate([
        {
          $geoNear: {
            near: {
              type: 'Point',
              coordinates: [parsedX, parsedY],
            },
            distanceField: 'distance',
            maxDistance: parsedRadius,
            spherical: true,
            query: filterQuery,
          },
        },
        {
          $project: {
            _id: 0,
            id: '$userId',
            userId: 1,
            username: 1,
            coordinates: '$location.coordinates',
            distance: { $round: ['$distance', 2] },
          },
        },
      ]);
    } catch (aggErr) {
      // Fallback: Using $near with User.find and calculating spherical distance in meters
      const foundUsers = await User.find({
        location: {
          $near: {
            $geometry: {
              type: 'Point',
              coordinates: [parsedX, parsedY],
            },
            $maxDistance: parsedRadius,
          },
        },
        ...filterQuery,
      }).lean();

      nearbyUsers = foundUsers.map((u) => {
        const [uLng, uLat] = u.location.coordinates;
        const dLat = ((uLat - parsedY) * Math.PI) / 180;
        const dLng = ((uLng - parsedX) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((parsedY * Math.PI) / 180) *
            Math.cos((uLat * Math.PI) / 180) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const distance = Math.round(6371000 * c * 100) / 100;

        return {
          id: u.userId,
          userId: u.userId,
          username: u.username || '',
          coordinates: u.location.coordinates,
          distance,
        };
      });
    }

    res.json({
      success: true,
      count: nearbyUsers.length,
      radius: parsedRadius,
      users: nearbyUsers,
    });
  } catch (error) {
    console.error('[API Error] Failed to discover nearby users:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve nearby users',
      message: error.message,
    });
  }
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

      // Check proximity for voice chat connections
      checkProximity(socket.id);
    }
  });

  // WebRTC signaling relay — forward offers, answers, and ICE candidates between peers
  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });

  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });

  socket.on('webrtc:ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice-candidate', { from: socket.id, candidate });
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

    // Clean up proximity pairs and notify remaining peers
    for (const pairKey of [...proximityPairs]) {
      if (pairKey.includes(socket.id)) {
        proximityPairs.delete(pairKey);
        const [id1, id2] = pairKey.split('::');
        const otherId = id1 === socket.id ? id2 : id1;
        io.to(otherId).emit('proximity:peer-left', { peerId: socket.id });
      }
    }

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

