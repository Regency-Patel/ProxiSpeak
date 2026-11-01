import { useEffect, useRef, useState, useCallback } from 'react';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Custom React hook for proximity-based WebRTC voice chat.
 * Manages peer connections, microphone access, and audio playback
 * based on proximity:peer-nearby / proximity:peer-left events from the server.
 *
 * @param {import('socket.io-client').Socket | null} socket - Socket.io client instance
 * @param {string | null} myId - Local user's socket ID
 * @returns {{ isMicEnabled, activePeers, micError, toggleMic, nearbyPeerIds }}
 */
export default function useProximityVoice(
  socket,
  myId,
  localPositionRef,
  remoteUsersRef,
  avatarSize,
  proximityRadius
) {
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  const [activePeers, setActivePeers] = useState({}); // peerId -> { status: 'connecting' | 'connected' | 'failed' }
  const [nearbyPeerIds, setNearbyPeerIds] = useState(new Set());
  const [micError, setMicError] = useState(null);

  const localStreamRef = useRef(null);
  const micAcquisitionPromiseRef = useRef(null);
  const micRequestVersionRef = useRef(0);
  const peerConnectionsRef = useRef({}); // peerId -> RTCPeerConnection
  const peerGenerationsRef = useRef({}); // peerId -> active proximity generation
  const peerConnectionGenerationsRef = useRef({}); // peerId -> generation owned by current RTCPeerConnection
  const failedPeerGenerationsRef = useRef({}); // peerId -> generation that failed
  const pendingCandidatesRef = useRef({}); // peerId -> ICECandidate[]
  const audioContextRef = useRef(null);
  const remoteAudioNodesRef = useRef({}); // peerId -> { stream, source, gain, panner, targetGain, targetPan }

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const AudioContextConstructor = window.AudioContext;
      if (!AudioContextConstructor) {
        console.error('[Voice] Web Audio API is not available in this browser.');
        return null;
      }
      try {
        audioContextRef.current = new AudioContextConstructor();
      } catch (err) {
        console.error('[Voice] Failed to create AudioContext:', err.message);
        return null;
      }
    }
    return audioContextRef.current;
  }, []);

  const resumeAudioContext = useCallback(async () => {
    const audioContext = getAudioContext();
    if (audioContext?.state === 'suspended') {
      try {
        await audioContext.resume();
      } catch (err) {
        console.error('[Voice] Failed to resume AudioContext:', err.message);
      }
    }
  }, [getAudioContext]);

  const closePeerAudio = useCallback((peerId) => {
    const audioNodes = remoteAudioNodesRef.current[peerId];
    if (!audioNodes) return;

    audioNodes.source.disconnect();
    audioNodes.gain.disconnect();
    audioNodes.panner.disconnect();
    delete remoteAudioNodesRef.current[peerId];
  }, []);

  const createPeerAudio = useCallback((peerId, stream) => {
    const existing = remoteAudioNodesRef.current[peerId];
    if (existing?.stream === stream) return;
    if (existing) closePeerAudio(peerId);

    const audioContext = getAudioContext();
    if (!audioContext) return;

    let source;
    let gain;
    let panner;
    try {
      source = audioContext.createMediaStreamSource(stream);
      gain = audioContext.createGain();
      panner = audioContext.createStereoPanner();
      gain.gain.setValueAtTime(0, audioContext.currentTime);
      panner.pan.setValueAtTime(0, audioContext.currentTime);
      source.connect(gain);
      gain.connect(panner);
      panner.connect(audioContext.destination);

      remoteAudioNodesRef.current[peerId] = {
        stream,
        source,
        gain,
        panner,
        targetGain: 0,
        targetPan: 0,
      };
    } catch (err) {
      source?.disconnect();
      gain?.disconnect();
      panner?.disconnect();
      console.error(`[Voice] Failed to create remote audio path for ${peerId}:`, err.message);
    }
  }, [closePeerAudio, getAudioContext]);

  const disposePeerConnection = useCallback((pc) => {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    if (pc.signalingState !== 'closed') {
      pc.close();
    }
  }, []);

  const isCurrentPeerGeneration = useCallback((peerId, generation, pc) => (
    typeof generation === 'string' &&
    peerGenerationsRef.current[peerId] === generation &&
    (!pc || (
      peerConnectionsRef.current[peerId] === pc &&
      peerConnectionGenerationsRef.current[peerId] === generation
    ))
  ), []);

  // ─── Microphone control ─────────────────────────────────────────────
  const acquireMic = useCallback(() => {
    if (localStreamRef.current) return Promise.resolve(localStreamRef.current);
    if (micAcquisitionPromiseRef.current) return micAcquisitionPromiseRef.current;

    const requestVersion = micRequestVersionRef.current;
    const acquisition = Promise.resolve()
      .then(() => navigator.mediaDevices.getUserMedia({ audio: true }))
      .then((stream) => {
        if (requestVersion !== micRequestVersionRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return null;
        }
        if (localStreamRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return localStreamRef.current;
        }
        localStreamRef.current = stream;
        setIsMicEnabled(true);
        setMicError(null);
        return stream;
      })
      .catch((err) => {
        console.error('[Voice] Microphone access denied:', err.message);
        if (requestVersion === micRequestVersionRef.current) {
          setMicError(err.name === 'NotAllowedError'
            ? 'Microphone permission denied'
            : err.message);
          setIsMicEnabled(false);
        }
        return null;
      });

    const trackedAcquisition = acquisition.finally(() => {
      if (micAcquisitionPromiseRef.current === trackedAcquisition) {
        micAcquisitionPromiseRef.current = null;
      }
    });
    micAcquisitionPromiseRef.current = trackedAcquisition;
    return trackedAcquisition;
  }, []);

  const releaseMic = useCallback(() => {
    micRequestVersionRef.current += 1;
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setIsMicEnabled(false);
  }, []);

  const toggleMic = useCallback(async () => {
    void resumeAudioContext();
    if (isMicEnabled) {
      // Mute: disable tracks but keep connections alive
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
      }
      setIsMicEnabled(false);
    } else {
      if (localStreamRef.current) {
        // Re-enable existing tracks
        localStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = true;
        });
        setIsMicEnabled(true);
      } else {
        await acquireMic();
      }
    }
  }, [isMicEnabled, acquireMic, resumeAudioContext]);

  // ─── Peer connection lifecycle ──────────────────────────────────────
  const createPeerConnection = useCallback(
    (peerId, generation) => {
      const currentPc = peerConnectionsRef.current[peerId];
      if (
        currentPc &&
        peerConnectionGenerationsRef.current[peerId] === generation
      ) {
        return currentPc;
      }

      // Close and clean up any existing connection to the same peer (but keep UI entry)
      if (currentPc) {
        // Dispose of resources without deleting the activePeers entry
        delete peerConnectionsRef.current[peerId];
        delete peerConnectionGenerationsRef.current[peerId];
        disposePeerConnection(currentPc);
        closePeerAudio(peerId);
        delete pendingCandidatesRef.current[peerId];
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnectionsRef.current[peerId] = pc;
      peerConnectionGenerationsRef.current[peerId] = generation;
      // Initialise the pending‑candidate queue only if it doesn't already exist.
      if (!pendingCandidatesRef.current[peerId]) {
        pendingCandidatesRef.current[peerId] = [];
      }

      // Attach local audio tracks to the connection
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current);
        });
      }

      // Forward ICE candidates to the remote peer via Socket.io
      pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit('webrtc:ice-candidate', {
            to: peerId,
            candidate: event.candidate,
            generation,
          });
        }
      };

      // Route only the remote stream through its peer-specific gain node.
      pc.ontrack = (event) => {
        // Ensure this event belongs to the current active connection for this peer
        if (!isCurrentPeerGeneration(peerId, generation, pc)) return;
        const remoteStream = event.streams[0];
        if (remoteStream) {
          createPeerAudio(peerId, remoteStream);
          setActivePeers((prev) => ({
            ...prev,
            [peerId]: { status: 'connected' },
          }));
        }
      };

      pc.onconnectionstatechange = () => {
        // Ensure this event belongs to the current active connection for this peer
        if (!isCurrentPeerGeneration(peerId, generation, pc)) return;
        const state = pc.connectionState;
        if (state === 'failed' || state === 'closed') {
          // Mark as failed and clean up resources, but keep the UI entry
          setActivePeers((prev) => ({
            ...prev,
            [peerId]: { status: 'failed' },
          }));
          closePeerAudio(peerId);
          delete pendingCandidatesRef.current[peerId];
          failedPeerGenerationsRef.current[peerId] = generation;
          delete peerConnectionsRef.current[peerId];
          delete peerConnectionGenerationsRef.current[peerId];
          disposePeerConnection(pc);
        }
        // "disconnected" is left as‑is – we keep the connection alive to allow recovery.
      };

      return pc;
    },
    [
      socket,
      closePeerAudio,
      createPeerAudio,
      disposePeerConnection,
      isCurrentPeerGeneration,
    ]
  );

  const closePeerConnection = useCallback((peerId) => {
    const pc = peerConnectionsRef.current[peerId];
    if (pc) {
      delete peerConnectionsRef.current[peerId];
      delete peerConnectionGenerationsRef.current[peerId];
      disposePeerConnection(pc);
    }
    delete pendingCandidatesRef.current[peerId];
    closePeerAudio(peerId);

    setActivePeers((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, [closePeerAudio, disposePeerConnection]);

  // ─── Socket event handlers ─────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    // When a peer enters proximity range
    const handlePeerNearby = async ({ peerId, shouldInitiate, generation }) => {
      if (typeof generation !== 'string') return;
      if (peerGenerationsRef.current[peerId] === generation) return;

      const currentPc = peerConnectionsRef.current[peerId];
      if (
        currentPc &&
        peerConnectionGenerationsRef.current[peerId] !== generation
      ) {
        closePeerConnection(peerId);
      }
      peerGenerationsRef.current[peerId] = generation;
      delete failedPeerGenerationsRef.current[peerId];
      pendingCandidatesRef.current[peerId] = [];
      setNearbyPeerIds((prev) => new Set([...prev, peerId]));

      // Acquire microphone if not already active
      let stream = localStreamRef.current;
      if (!stream) {
        stream = await acquireMic();
        if (!stream) return; // mic access denied — can't do voice
      }
      if (!isCurrentPeerGeneration(peerId, generation)) return;

      if (shouldInitiate) {
        // This client creates and sends the WebRTC offer
        const pc = createPeerConnection(peerId, generation);
        try {
          const offer = await pc.createOffer();
          if (!isCurrentPeerGeneration(peerId, generation, pc)) return;
          await pc.setLocalDescription(offer);
          if (!isCurrentPeerGeneration(peerId, generation, pc)) return;
          socket.emit('webrtc:offer', { to: peerId, offer, generation });

          setActivePeers((prev) => ({
            ...prev,
            [peerId]: { status: 'connecting' },
          }));
        } catch (err) {
          console.error('[WebRTC] Failed to create offer:', err);
        }
      } else {
        // Mark as pending — will connect when the offer arrives
        setActivePeers((prev) => ({
          ...prev,
          [peerId]: { status: 'connecting' },
        }));
      }
    };

    // When a peer leaves proximity range
    const handlePeerLeft = ({ peerId, generation }) => {
      if (
        generation &&
        peerGenerationsRef.current[peerId] !== generation
      ) return;
      delete peerGenerationsRef.current[peerId];
      delete failedPeerGenerationsRef.current[peerId];
      setNearbyPeerIds((prev) => {
        const next = new Set(prev);
        next.delete(peerId);
        return next;
      });
      closePeerConnection(peerId);
    };

    // Receive a WebRTC offer from a remote peer
    const handleOffer = async ({ from, offer, generation }) => {
      if (
        !isCurrentPeerGeneration(from, generation) ||
        failedPeerGenerationsRef.current[from] === generation
      ) return;
      const existingPc = peerConnectionsRef.current[from];
      if (
        existingPc &&
        peerConnectionGenerationsRef.current[from] === generation
      ) return;

      let stream = localStreamRef.current;
      if (!stream) {
        stream = await acquireMic();
        if (!stream) return;
      }
      if (!isCurrentPeerGeneration(from, generation)) return;

      const pc = createPeerConnection(from, generation);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        if (!isCurrentPeerGeneration(from, generation, pc)) return;

        // Flush any ICE candidates that arrived before the offer
        const pending = pendingCandidatesRef.current[from] || [];
        for (const queuedCandidate of pending) {
          if (queuedCandidate.generation !== generation) continue;
          await pc.addIceCandidate(new RTCIceCandidate(queuedCandidate.candidate));
          if (!isCurrentPeerGeneration(from, generation, pc)) return;
        }
        pendingCandidatesRef.current[from] = [];

        const answer = await pc.createAnswer();
        if (!isCurrentPeerGeneration(from, generation, pc)) return;
        await pc.setLocalDescription(answer);
        if (!isCurrentPeerGeneration(from, generation, pc)) return;
        socket.emit('webrtc:answer', { to: from, answer, generation });
      } catch (err) {
        console.error('[WebRTC] Failed to handle offer:', err);
      }
    };

    // Receive a WebRTC answer from a remote peer
    const handleAnswer = async ({ from, answer, generation }) => {
      if (!isCurrentPeerGeneration(from, generation)) return;
      const pc = peerConnectionsRef.current[from];
      if (!pc || !isCurrentPeerGeneration(from, generation, pc)) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        if (!isCurrentPeerGeneration(from, generation, pc)) return;

        const pending = pendingCandidatesRef.current[from] || [];
        for (const queuedCandidate of pending) {
          if (queuedCandidate.generation !== generation) continue;
          await pc.addIceCandidate(new RTCIceCandidate(queuedCandidate.candidate));
          if (!isCurrentPeerGeneration(from, generation, pc)) return;
        }
        pendingCandidatesRef.current[from] = [];
      } catch (err) {
        console.error('[WebRTC] Failed to handle answer:', err);
      }
    };

    // Receive an ICE candidate from a remote peer
    const handleIceCandidate = async ({ from, candidate, generation }) => {
      if (
        !isCurrentPeerGeneration(from, generation) ||
        failedPeerGenerationsRef.current[from] === generation
      ) return;
      const pc = peerConnectionsRef.current[from];
      if (
        pc &&
        isCurrentPeerGeneration(from, generation, pc) &&
        pc.remoteDescription
      ) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          if (!isCurrentPeerGeneration(from, generation, pc)) return;
        } catch (err) {
          console.error('[WebRTC] Failed to add ICE candidate:', err);
        }
      } else {
        // Queue until remote description is set
        if (!pendingCandidatesRef.current[from]) {
          pendingCandidatesRef.current[from] = [];
        }
        pendingCandidatesRef.current[from].push({ candidate, generation });
      }
    };

    socket.on('proximity:peer-nearby', handlePeerNearby);
    socket.on('proximity:peer-left', handlePeerLeft);
    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice-candidate', handleIceCandidate);

    return () => {
      socket.off('proximity:peer-nearby', handlePeerNearby);
      socket.off('proximity:peer-left', handlePeerLeft);
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice-candidate', handleIceCandidate);

      // Tear down every active peer connection
      Object.keys(peerConnectionsRef.current).forEach(closePeerConnection);
      Object.keys(remoteAudioNodesRef.current).forEach(closePeerAudio);
      peerGenerationsRef.current = {};
      peerConnectionGenerationsRef.current = {};
      failedPeerGenerationsRef.current = {};
      if (audioContextRef.current) {
        const audioContext = audioContextRef.current;
        audioContextRef.current = null;
        if (audioContext.state !== 'closed') {
          void audioContext.close().catch((err) => {
            console.error('[Voice] Failed to close AudioContext:', err.message);
          });
        }
      }
      releaseMic();
    };
  }, [
    socket,
    acquireMic,
    releaseMic,
    createPeerConnection,
    closePeerConnection,
    closePeerAudio,
    isCurrentPeerGeneration,
  ]);

  useEffect(() => {
    let animationFrameId;

    const updatePeerVolumes = () => {
      const audioContext = audioContextRef.current;
      if (audioContext && audioContext.state !== 'closed') {
        const localPosition = localPositionRef?.current;

        Object.entries(remoteAudioNodesRef.current).forEach(([peerId, audioNodes]) => {
          const remotePosition = remoteUsersRef?.current?.[peerId];
          let targetGain = 0;
          let targetPan = 0;

          if (
            localPosition &&
            remotePosition &&
            Number.isFinite(localPosition.x) &&
            Number.isFinite(localPosition.y) &&
            Number.isFinite(remotePosition.x) &&
            Number.isFinite(remotePosition.y)
          ) {
            const centerOffset = avatarSize / 2;
            const dx = (localPosition.x + centerOffset) - (remotePosition.x + centerOffset);
            const dy = (localPosition.y + centerOffset) - (remotePosition.y + centerOffset);
            const distance = Math.sqrt(dx * dx + dy * dy);
            const normalizedDistance = Math.min(distance / proximityRadius, 1);
            targetGain = 0.5 * (1 + Math.cos(Math.PI * normalizedDistance));
            const horizontalOffset = remotePosition.x - localPosition.x;
            targetPan = Math.max(
              -1,
              Math.min(horizontalOffset / proximityRadius, 1)
            );
          }

          if (Math.abs(targetGain - audioNodes.targetGain) > 0.001) {
            audioNodes.targetGain = targetGain;
            audioNodes.gain.gain.setTargetAtTime(
              targetGain,
              audioContext.currentTime,
              0.08
            );
          }
          if (Math.abs(targetPan - audioNodes.targetPan) > 0.001) {
            audioNodes.targetPan = targetPan;
            audioNodes.panner.pan.setTargetAtTime(
              targetPan,
              audioContext.currentTime,
              0.08
            );
          }
        });
      }

      animationFrameId = requestAnimationFrame(updatePeerVolumes);
    };

    animationFrameId = requestAnimationFrame(updatePeerVolumes);
    return () => cancelAnimationFrame(animationFrameId);
  }, [localPositionRef, remoteUsersRef, avatarSize, proximityRadius]);

  return {
    isMicEnabled,
    activePeers,
    nearbyPeerIds,
    micError,
    toggleMic,
  };
}
