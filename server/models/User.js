import mongoose from 'mongoose';

/**
 * User Schema with 2D Geospatial Support
 * GeoJSON Point standard: coordinates are ordered as [longitude, latitude] (or [x, y])
 */
const userSchema = new mongoose.Schema(
  {
    // Unique user identifier (e.g., persistent user ID or unique handle)
    userId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    // Optional display name for avatar
    username: {
      type: String,
      trim: true,
      default: '',
    },
    // GeoJSON Point format for 2D position tracking
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
        required: true,
      },
      coordinates: {
        type: [Number], // [longitude, latitude] or [x, y] in 2D space
        required: true,
        default: [0, 0],
      },
    },
    // Online status flag
    isActive: {
      type: Boolean,
      default: true,
    },
    // Last activity timestamp for heartbeat / session cleanup
    lastActive: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// 2dsphere index for geospatial proximity queries ($near, $geoWithin, etc.)
userSchema.index({ location: '2dsphere' });

const User = mongoose.model('User', userSchema);

export default User;
