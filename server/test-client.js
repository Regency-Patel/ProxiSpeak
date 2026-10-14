import { io } from 'socket.io-client';

const socket = io('http://localhost:3001', {
  transports: ['websocket', 'polling']
});

console.log('Connecting to Socket.io server on http://localhost:3001...');

socket.on('connect', () => {
  console.log(`[Test Client] Successfully connected to server with socket ID: ${socket.id}`);
  
  // Wait 1 second then disconnect
  setTimeout(() => {
    console.log('[Test Client] Disconnecting cleanly...');
    socket.disconnect();
    console.log('[Test Client] Test completed successfully.');
    process.exit(0);
  }, 1000);
});

socket.on('connect_error', (err) => {
  console.error(`[Test Client] Connection error: ${err.message}`);
  console.error(`\n💡 Hint: The backend server is not running yet.`);
  console.error(`👉 First run "npm start" in this or another terminal window to start the server, then run "npm test".\n`);
  process.exit(1);
});
